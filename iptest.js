import fs from "fs";
import net from "net";
import tls from "tls";
import https from "https";
import path from "path";

// 输入CSV文件路径，包含代理IP和端口信息
const IPS_CSV = "init.csv";

// locations.json 文件路径，用于存储地理位置信息
const LOCATIONS_JSON = "locations.json";

// 输出文件路径，保存每个国家前LIMIT_PER_COUNTRY个有效代理IP
const OUTPUT_FILE = "ip_top5.txt";

// 输出文件路径，保存所有有效代理IP（不限制数量）
const OUTPUT_ALL = "ip_all.txt";

// 设置代理IP的类型，支持 'ipv4' 和 'ipv6'
const OUTPUT_TYPE = "ipv4";

// 从哪里下载locations.json文件
const LOCATIONS_URL = "https://locations-adw.pages.dev";

// 每个国家输出的代理数量
const LIMIT_PER_COUNTRY = 5;

// 控制并发请求的最大数量，避免过高的并发造成负载过大
const CONCURRENCY_LIMIT = 200;

// HTTP请求的超时设置，单位为毫秒
const TIMEOUT_MS = 3000;

// TCP连接的超时时间，单位为毫秒
const TCP_TIMEOUT_MS = 2000;

// TLS连接的超时时间，单位为毫秒
const TLS_TIMEOUT_MS = 2000;

// 在文件开头，imports 之后添加
process.on("uncaughtException", (error) => {
  // 忽略所有预期的网络错误
  if (
    error.code === "EHOSTUNREACH" ||
    error.code === "ECONNREFUSED" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ENETUNREACH" ||
    error.code === "EADDRNOTAVAIL" ||
    error.code === "ECONNRESET" ||
    error.code === "EPIPE" ||
    error.message.includes("bad record type")
  ) {
    // 这些是预期的错误，安静地忽略
    return;
  }
  console.error("未捕获的异常:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  // 忽略所有预期的网络错误
  if (
    reason?.code === "EHOSTUNREACH" ||
    reason?.code === "ECONNREFUSED" ||
    reason?.code === "ETIMEDOUT" ||
    reason?.code === "ENETUNREACH" ||
    reason?.code === "EADDRNOTAVAIL" ||
    reason?.code === "ECONNRESET" ||
    reason?.code === "ERR_SSL_BAD_RECORD_TYPE"
  ) {
    return;
  }
  console.error("未处理的Promise拒绝:", reason);
});

// 检查 locations.json 是否存在
async function checkLocationsJson() {
  try {
    await fs.promises.access(LOCATIONS_JSON);
    console.log(`${LOCATIONS_JSON} 文件已存在`);
  } catch (error) {
    console.log(`${LOCATIONS_JSON} 文件不存在，正在下载...`);
    await downloadLocationsJson();
  }
}

// 从 URL 下载 locations.json
async function downloadLocationsJson() {
  return new Promise((resolve, reject) => {
    https
      .get(LOCATIONS_URL, (response) => {
        // 如果状态码不是 200，立即拒绝并退出
        if (response.statusCode !== 200) {
          console.log(`下载失败，HTTP 状态码: ${response.statusCode}`);
          reject(new Error(`下载失败，HTTP 状态码: ${response.statusCode}`));
          return;
        } else {
          let fileContent = "";

          // 监听数据流
          response.on("data", (chunk) => {
            fileContent += chunk;
          });

          response.on("end", () => {
            // 如果文件内容为空，则不创建文件并返回错误
            if (fileContent.trim() === "") {
              console.log(`${LOCATIONS_JSON} 文件内容为空，未保存`);
              reject(new Error("文件内容为空，未保存"));
              return; // 防止继续创建文件
            }

            // 如果文件内容有效时，创建文件并保存
            fs.writeFileSync(LOCATIONS_JSON, fileContent, "utf8");
            console.log(`${LOCATIONS_JSON} 下载并保存完成`);
            resolve();
          });
        }
      })
      .on("error", (err) => {
        reject(new Error(`下载过程中发生错误: ${err.message}`));
      });
  });
}
/**
 * 自定义TCP/TLS连接池 - 暴力复用模式（终极修复版）
 */
class ConnectionPool {
  constructor() {
    this.connections = new Map();
    this.maxIdleTime = 30000;
    this.maxPoolSize = 500;
    this.stats = {
      hits: 0,
      misses: 0,
      created: 0,
      closed: 0,
      errors: 0,
    };
  }

  /**
   * 获取或创建连接
   */
  async getConnection(ip, port, useTLS = true) {
    const key = `${ip}:${port}`;
    let conn = this.connections.get(key);

    // 命中连接池
    if (conn && !conn.socket.destroyed) {
      conn.lastUsed = Date.now();
      this.stats.hits++;

      // 如果需要TLS但当前只有TCP连接，升级连接
      if (useTLS && !conn.tlsSocket) {
        try {
          conn.tlsSocket = await this.upgradeToTLS(conn.socket);
        } catch (error) {
          this.stats.errors++;
          this.connections.delete(key);
          throw error;
        }
      }

      return conn;
    }

    // 未命中，创建新连接
    this.stats.misses++;

    try {
      const socket = await this.createTCPSocket(ip, port);

      conn = {
        socket,
        tlsSocket: null,
        lastUsed: Date.now(),
        key,
      };

      if (useTLS) {
        conn.tlsSocket = await this.upgradeToTLS(socket);
      }

      this.connections.set(key, conn);
      this.stats.created++;

      // 限制连接池大小
      if (this.connections.size > this.maxPoolSize) {
        this.cleanup(true);
      }

      return conn;
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * 创建TCP连接 - 终极修复版
   */
  createTCPSocket(ip, port) {
    return new Promise((resolve, reject) => {
      // 1. 先创建socket实例
      const socket = new net.Socket();

      // 标记是否已经处理完成
      let isDone = false;

      // 2. 立即设置错误处理器 - 在连接开始之前！
      const onError = (err) => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TCP连接失败: ${err.message}`));
      };

      socket.once("error", onError);

      // 3. 设置超时
      socket.setTimeout(TCP_TIMEOUT_MS);

      // 4. 连接成功处理器
      const onConnect = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        socket.setKeepAlive(true, 60000);
        socket.setNoDelay(true);
        resolve(socket);
      };

      // 5. 超时处理器
      const onTimeout = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TCP连接超时 (${TCP_TIMEOUT_MS}ms)`));
      };

      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
      };

      socket.once("connect", onConnect);
      socket.once("timeout", onTimeout);

      // 6. 最后才发起连接
      socket.connect(parseInt(port), ip);
    });
  }

  /**
   * 将TCP连接升级到TLS - 完全修复版
   */
  upgradeToTLS(socket) {
    return new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({
        socket: socket,
        servername: "speed.cloudflare.com",
        rejectUnauthorized: false,
        timeout: TLS_TIMEOUT_MS,
      });

      let isDone = false;

      // 定义错误处理函数
      const onError = (err) => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TLS握手失败: ${err.message}`));
      };

      // 立即监听错误
      tlsSocket.once("error", onError);

      const onSecureConnect = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        tlsSocket.setKeepAlive(true, 60000);
        tlsSocket.setNoDelay(true);
        resolve(tlsSocket);
      };

      const onTimeout = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TLS握手超时 (${TLS_TIMEOUT_MS}ms)`));
      };

      const cleanup = () => {
        tlsSocket.removeListener("secureConnect", onSecureConnect);
        tlsSocket.removeListener("error", onError);
        tlsSocket.removeListener("timeout", onTimeout);
      };

      tlsSocket.once("secureConnect", onSecureConnect);
      tlsSocket.once("timeout", onTimeout);
    });
  }

  /**
   * 释放连接回池
   */
  release(ip, port) {
    const key = `${ip}:${port}`;
    const conn = this.connections.get(key);
    if (conn) {
      conn.lastUsed = Date.now();
    }
  }

  /**
   * 清理空闲连接
   */
  cleanup(force = false) {
    const now = Date.now();
    let closed = 0;

    for (const [key, conn] of this.connections.entries()) {
      const isIdle = now - conn.lastUsed > this.maxIdleTime;
      const needShrink = force && this.connections.size > this.maxPoolSize;

      if (isIdle || needShrink) {
        if (conn.tlsSocket) {
          try {
            conn.tlsSocket.destroy();
          } catch (e) {}
        }
        if (conn.socket) {
          try {
            conn.socket.destroy();
          } catch (e) {}
        }
        this.connections.delete(key);
        closed++;
      }
    }

    this.stats.closed += closed;
    return closed;
  }

  /**
   * 关闭所有连接
   */
  destroy() {
    const count = this.cleanup(true);
    this.stats.closed += count;

    console.log(`\n📊 连接池统计:`);
    console.log(`  ✅ 命中: ${this.stats.hits}`);
    console.log(`  ❌ 未命中: ${this.stats.misses}`);
    console.log(`  📦 创建: ${this.stats.created}`);
    console.log(`  🗑️  关闭: ${this.stats.closed}`);
    console.log(`  ⚠️  错误: ${this.stats.errors}`);
    console.log(`  💾 剩余: ${this.connections.size}`);
  }
}

// 全局连接池
const connectionPool = new ConnectionPool();

/**
 * 带超时的连接获取
 */
async function getConnectionWithTimeout(ip, port, useTLS = true) {
  return Promise.race([
    connectionPool.getConnection(ip, port, useTLS),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`获取连接超时 (${TCP_TIMEOUT_MS}ms)`)),
        TCP_TIMEOUT_MS + 500,
      ),
    ),
  ]);
}

/**
 * 发送原始HTTP/1.1请求
 */
async function sendHttpRequest(socket, host, path = "/cdn-cgi/trace") {
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Connection: keep-alive",
    "Accept: */*",
    "Accept-Encoding: identity",
    "",
    "",
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP请求超时"));
    }, TIMEOUT_MS);

    let buffer = Buffer.alloc(0);
    let headersEnd = -1;
    let contentLength = -1;
    let isChunked = false;
    let bodyStart = 0;
    let resolved = false;

    const onData = (chunk) => {
      if (resolved) return;

      buffer = Buffer.concat([buffer, chunk]);

      // 查找headers结束位置
      if (headersEnd === -1) {
        headersEnd = buffer.indexOf("\r\n\r\n");
        if (headersEnd !== -1) {
          const headers = buffer.slice(0, headersEnd).toString();

          if (!headers.startsWith("HTTP/1.1 200")) {
            cleanup();
            reject(new Error(`非200状态码`));
            return;
          }

          const clMatch = headers.match(/content-length: (\d+)/i);
          if (clMatch) {
            contentLength = parseInt(clMatch[1], 10);
          }

          isChunked = headers
            .toLowerCase()
            .includes("transfer-encoding: chunked");
          bodyStart = headersEnd + 4;
        }
      }

      // 检查body是否完整
      if (headersEnd !== -1 && !resolved) {
        const bodyBuffer = buffer.slice(bodyStart);

        if (contentLength > 0 && bodyBuffer.length >= contentLength) {
          resolved = true;
          const body = bodyBuffer.slice(0, contentLength).toString();
          cleanup();
          resolve(body);
        } else if (isChunked) {
          if (bodyBuffer.slice(-5).toString() === "0\r\n\r\n") {
            resolved = true;
            // 简单的chunked解码
            const body = bodyBuffer.toString();
            const chunks = [];
            let pos = 0;
            while (pos < body.length) {
              const lineEnd = body.indexOf("\r\n", pos);
              if (lineEnd === -1) break;
              const chunkSize = parseInt(body.slice(pos, lineEnd), 16);
              if (chunkSize === 0) break;
              const chunkStart = lineEnd + 2;
              const chunkEnd = chunkStart + chunkSize;
              chunks.push(body.slice(chunkStart, chunkEnd));
              pos = chunkEnd + 2;
            }
            cleanup();
            resolve(chunks.join(""));
          }
        }
      }
    };

    const onError = (err) => {
      cleanup();
      reject(new Error(`Socket错误: ${err.message}`));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("连接关闭"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);

    try {
      socket.write(request);
    } catch (err) {
      cleanup();
      reject(new Error(`写入请求失败: ${err.message}`));
    }
  });
}

/**
 * 判断是否为IPv6地址
 */
const isIPv6 = (ip) => net.isIPv6(ip);

/**
 * 从trace响应中提取ip和colo字段
 */
const extractFromTrace = (traceText) => {
  const result = {};

  if (!traceText) return { ip: null, colo: null };

  const lines = traceText.split("\n");
  lines.forEach((line) => {
    const index = line.indexOf("=");
    if (index > 0) {
      const key = line.substring(0, index).trim();
      const value = line.substring(index + 1).trim();
      if (key && value) {
        result[key] = value;
      }
    }
  });

  return {
    ip: result.ip || null,
    colo: result.colo || null,
  };
};

/**
 * 读取ips.csv文件
 */
async function readIpsCsv() {
  try {
    const content = await fs.promises.readFile(IPS_CSV, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    if (lines.length === 0) {
      throw new Error("CSV文件为空");
    }

    const headers = lines[0].split(",").map((h) => h.trim());
    const ipIndex = headers.findIndex(
      (h) => h.includes("IP") || h.includes("ip"),
    );
    const portIndex = headers.findIndex(
      (h) => h.includes("端口") || h.includes("port"),
    );

    if (ipIndex === -1 || portIndex === -1) {
      throw new Error("CSV文件中未找到IP地址或端口号列");
    }

    console.log(`📋 解析CSV: IP列[${ipIndex}], 端口列[${portIndex}]`);

    const proxyList = [];
    for (let i = 1; i < lines.length; i++) {
      const columns = lines[i].split(",");
      if (columns.length > Math.max(ipIndex, portIndex)) {
        const ip = columns[ipIndex]?.replace(/"/g, "").trim();
        const port = columns[portIndex]?.replace(/"/g, "").trim();

        if (ip && port && net.isIP(ip) && !isNaN(parseInt(port))) {
          proxyList.push(`${ip}:${port}`);
        }
      }
    }

    console.log(
      `📊 加载完成: ${proxyList.length} 个IP (共${lines.length - 1}行)`,
    );
    return proxyList;
  } catch (error) {
    console.error(`❌ 读取失败 ${IPS_CSV}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 读取locations.json文件
 */
async function readLocationsJson() {
  try {
    const content = await fs.promises.readFile(LOCATIONS_JSON, "utf8");
    const locations = JSON.parse(content);

    const coloMap = new Map();
    locations.forEach((location) => {
      if (location.iata && location.country && location.emoji) {
        coloMap.set(location.iata, {
          country: location.country,
          emoji: location.emoji,
          region: location.region || "",
        });
      }
    });

    console.log(`📊 加载完成: ${LOCATIONS_JSON} (${coloMap.size}个数据中心)`);
    return coloMap;
  } catch (error) {
    console.error(`❌ 读取失败 ${LOCATIONS_JSON}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 按国家分组代理
 */
const groupByCountry = (proxies) => {
  const groups = {};
  proxies.forEach((proxy) => {
    const country = proxy.country;
    if (!groups[country]) {
      groups[country] = [];
    }
    groups[country].push(proxy);
  });
  return groups;
};

/**
 * 为每个国家的代理添加序号，并生成全部和指定数量两个版本
 * 只有代理数量 >= LIMIT_PER_COUNTRY 的国家才会输出（两个版本都过滤）
 */
const addSequentialNumbers = (validProxyObjects, limitPerCountry = 5) => {
  // 按国家分组
  const groups = groupByCountry(validProxyObjects);

  const allNumberedProxies = [];
  const limitedNumberedProxies = [];

  // 对每个国家组内部重新编号
  Object.keys(groups)
    .sort()
    .forEach((country) => {
      const groupProxies = groups[country];

      // 只有该国家代理数量 >= limitPerCountry 时才输出（全部和限制都过滤）
      if (groupProxies.length >= limitPerCountry) {
        // 全部数量 - 所有代理都带序号
        groupProxies.forEach((proxy, index) => {
          const sequenceNumber = index + 1;
          const formattedProxy = `${proxy.ipPort}#${proxy.emoji}${proxy.country}${sequenceNumber}`;
          allNumberedProxies.push(formattedProxy);
        });

        // 指定数量 - 只取前 limitPerCountry 个
        groupProxies.slice(0, limitPerCountry).forEach((proxy, index) => {
          const sequenceNumber = index + 1;
          const formattedProxy = `${proxy.ipPort}#${proxy.emoji}${proxy.country}${sequenceNumber}`;
          limitedNumberedProxies.push(formattedProxy);
        });
      }
      // 数量不足的国家，两个版本都不输出
    });

  return {
    all: allNumberedProxies,
    limited: limitedNumberedProxies,
  };
};

/**
 * 暴力复用方式检测单个代理
 */
async function checkProxy(proxyAddress, coloMap, ipVersion = "all") {
  const parts = proxyAddress.split(":");
  if (parts.length !== 2) {
    return null;
  }

  const ip = parts[0];
  const port = parseInt(parts[1], 10);
  const startTime = Date.now();

  let conn = null;
  let hasConnection = false;

  try {
    // 1. 获取复用连接 - 带超时
    conn = await getConnectionWithTimeout(ip, port, true);
    hasConnection = true;

    // 2. 发送请求
    const traceData = await sendHttpRequest(
      conn.tlsSocket || conn.socket,
      "speed.cloudflare.com",
      "/cdn-cgi/trace",
    );

    const elapsed = Date.now() - startTime;
    const { ip: outboundIp, colo } = extractFromTrace(traceData);

    if (!outboundIp) {
      console.log(`  ⚠️ ${proxyAddress.padEnd(21)} 无IP信息 (${elapsed}ms)`);
      connectionPool.release(ip, port);
      return null;
    }

    // 获取colo信息
    let locationInfo = null;
    let countryDisplay = "";
    if (colo && coloMap.has(colo)) {
      locationInfo = coloMap.get(colo);
      countryDisplay = `${locationInfo.emoji} ${locationInfo.country}`;
    }

    const isOutboundIPv6 = isIPv6(outboundIp); // 修改2: 判断出口IP版本

    // 修改3: 根据ipVersion参数过滤
    if (ipVersion === "ipv4" && isOutboundIPv6) {
      // 仅IPv4模式，拒绝IPv6出口
      if (locationInfo) {
        console.log(
          `  ⚠️ ${proxyAddress.padEnd(21)} IPv6出口 ${countryDisplay} (${elapsed}ms) - 已过滤`,
        );
      } else {
        console.log(
          `  ⚠️ ${proxyAddress.padEnd(21)} IPv6出口 COLO:${colo || "未知"} (${elapsed}ms) - 已过滤`,
        );
      }
      connectionPool.release(ip, port);
      return null;
    }

    if (ipVersion === "ipv6" && !isOutboundIPv6) {
      // 仅IPv6模式，拒绝IPv4出口
      if (locationInfo) {
        console.log(
          `  ⚠️ ${proxyAddress.padEnd(21)} IPv4出口 ${countryDisplay} (${elapsed}ms) - 已过滤`,
        );
      } else {
        console.log(
          `  ⚠️ ${proxyAddress.padEnd(21)} IPv4出口 COLO:${colo || "未知"} (${elapsed}ms) - 已过滤`,
        );
      }
      connectionPool.release(ip, port);
      return null;
    }

    // 修改4: IPv6出口处理
    if (isOutboundIPv6) {
      // IPv6出口必须要有colo信息
      if (!colo || !coloMap.has(colo)) {
        if (locationInfo) {
          console.log(
            `  ⚠️ ${proxyAddress.padEnd(21)} IPv6出口 ${countryDisplay} (${elapsed}ms) - 未知数据中心`,
          );
        } else {
          console.log(
            `  ⚠️ ${proxyAddress.padEnd(21)} IPv6出口 COLO:${colo || "未知"} (${elapsed}ms) - 不在数据库`,
          );
        }
        connectionPool.release(ip, port);
        return null;
      }

      // ✅ 有效IPv6代理
      console.log(
        `  ✅ ${proxyAddress.padEnd(21)} IPv6出口 ${countryDisplay} (${elapsed}ms)`,
      );

      // 释放连接回池
      connectionPool.release(ip, port);

      // 返回包含完整信息的对象
      return {
        ipPort: proxyAddress,
        country: locationInfo.country,
        emoji: locationInfo.emoji,
        colo: colo,
        timestamp: Date.now(),
        ipVersion: "ipv6", // 修改5: 标记IP版本
      };
    }

    // IPv4出口且colo必须存在
    if (!colo || !coloMap.has(colo)) {
      if (locationInfo) {
        console.log(
          `  ⚠️ ${proxyAddress.padEnd(21)} IPv4出口 ${countryDisplay} (${elapsed}ms) - 未知数据中心`,
        );
      } else {
        console.log(
          `  ⚠️ ${proxyAddress.padEnd(21)} IPv4出口 COLO:${colo || "未知"} (${elapsed}ms) - 不在数据库`,
        );
      }
      connectionPool.release(ip, port);
      return null;
    }

    // ✅ 有效IPv4代理
    console.log(
      `  ✅ ${proxyAddress.padEnd(21)} IPv4出口 ${countryDisplay} (${elapsed}ms)`,
    );

    // 释放连接回池
    connectionPool.release(ip, port);

    // 返回包含完整信息的对象
    return {
      ipPort: proxyAddress,
      country: locationInfo.country,
      emoji: locationInfo.emoji,
      colo: colo,
      timestamp: Date.now(),
      ipVersion: "ipv4", // 修改6: 标记IP版本
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;

    // 超时不打印具体IP，避免刷屏
    if (error.message.includes("超时")) {
      if (elapsed > 9000) {
        console.log(`  ⏱️ ${proxyAddress.padEnd(21)} 超时 (${elapsed}ms)`);
      }
    } else {
      //console.log(
      //   `  ❌ ${proxyAddress.padEnd(21)} ${error.message.substring(0, 30)} (${elapsed}ms)`,
      //  );
    }

    // 发生错误时也要释放连接
    if (hasConnection) {
      connectionPool.release(ip, port);
    }
    return null;
  }
}
/**
 * 并发控制处理器 - 工作池模式（修复版）
 */
async function processBatch(items, concurrency, processor, coloMap) {
  const results = [];
  const total = items.length;
  let completed = 0;

  // 使用索引而不是shift，避免竞争
  let currentIndex = 0;

  console.log(
    `\n🚀 开始检测 ${total} 个 Proxyip (并发${concurrency}, 连接池复用模式)\n`,
  );

  // 工作池
  const worker = async () => {
    while (true) {
      // 原子操作：获取下一个索引
      const index = currentIndex++;
      if (index >= total) break;

      const item = items[index];
      try {
        const result = await processor(item, coloMap);
        if (result) results.push(result);
      } catch (error) {
        // 未捕获的错误
        console.log(`  💥 ${item.padEnd(21)} 错误: ${error.message}`);
      }

      completed++;

      // 进度显示 - 每10个或完成时
      if (completed % 10 === 0 || completed === total) {
        const percent = ((completed / total) * 100).toFixed(1);
        const hitRate =
          connectionPool.stats.hits + connectionPool.stats.misses > 0
            ? (
                (connectionPool.stats.hits /
                  (connectionPool.stats.hits + connectionPool.stats.misses)) *
                100
              ).toFixed(1)
            : "0.0";

        console.log(
          `  📊 进度: ${completed}/${total} (${percent}%) | 有效: ${results.length} | 命中: ${hitRate}% | 池: ${connectionPool.connections.size}`,
        );
      }
    }
  };

  // 启动指定数量的worker，不超过总任务数
  const workerCount = Math.min(concurrency, total);
  const workers = Array(workerCount)
    .fill()
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

/**
 * 打印统计摘要
 */
function printSummary(proxyAddresses, validProxies, elapsedTime) {
  const total = proxyAddresses.length;
  const valid = validProxies.length;
  const invalid = total - valid;
  const successRate = ((valid / total) * 100).toFixed(1);

  const hitRate =
    connectionPool.stats.hits + connectionPool.stats.misses > 0
      ? (
          (connectionPool.stats.hits /
            (connectionPool.stats.hits + connectionPool.stats.misses)) *
          100
        ).toFixed(1)
      : "0.0";

  console.log("\n" + "=".repeat(70));
  console.log("📊 检测完成统计");
  console.log("=".repeat(70));
  console.log(`  总 Proxyip 数:     ${total}`);
  console.log(`  ✅ 可用:           ${valid} (${successRate}%)`);
  console.log(`  ❌ 无效:           ${invalid}`);
  console.log(`  ⏱️  耗时:           ${elapsedTime.toFixed(1)}s`);
  console.log(`  ⚡ 平均速度:        ${(total / elapsedTime).toFixed(1)}个/秒`);
  console.log(`  🎯 连接池命中率:    ${hitRate}%`);
  console.log(`  💾 连接池大小:      ${connectionPool.connections.size}个`);
  console.log("=".repeat(70));
}

/**
 * 启动连接池清理定时器
 */
function startCleanupTimer() {
  setInterval(() => {
    const before = connectionPool.connections.size;
    const closed = connectionPool.cleanup();
    if (closed > 0) {
      console.log(
        `🧹 连接池清理: ${before} → ${connectionPool.connections.size} (关闭${closed}个空闲连接)`,
      );
    }
  }, 10000);
}

/**
 * 主函数
 */
async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("🚀 Cloudflare CDN Proxyip 检测工具 v3.0 - 连接池复用模式");
  console.log("=".repeat(70) + "\n");

  const startTime = Date.now();

  try {
    // 启动连接池清理
    startCleanupTimer();

    // 读取ips.csv
    console.log("📖 读取配置文件...");
    const proxyAddresses = await readIpsCsv();

    if (proxyAddresses.length === 0) {
      console.log("⚠️ 没有IP地址，程序退出");
      return;
    }

    // 读取locations.json
    await checkLocationsJson();
    const coloMap = await readLocationsJson();

    // 打乱顺序，避免集中测试同一IP段
    const shuffled = [...proxyAddresses].sort(() => Math.random() - 0.5);

    // 批量检测代理
    const validProxyObjects = await processBatch(
      shuffled,
      CONCURRENCY_LIMIT,
      (proxy, map) => checkProxy(proxy, map, OUTPUT_TYPE),
      coloMap,
    );

    // 关闭连接池
    connectionPool.destroy();

    // 计算总耗时
    const totalTime = (Date.now() - startTime) / 1000;

    // 为每个国家的代理添加序号，生成全部和限制数量两个版本
    const { all: allProxies, limited: limitedProxies } = addSequentialNumbers(
      validProxyObjects,
      LIMIT_PER_COUNTRY,
    );

    // 打印统计摘要
    printSummary(proxyAddresses, validProxyObjects, totalTime);

    // 保存结果
    if (allProxies.length > 0) {
      // 1. 保存全部代理（带序号）
      await fs.promises.writeFile(OUTPUT_ALL, allProxies.join("\n"), "utf8");
      console.log(
        `💾 已保存: ${OUTPUT_ALL} (全部代理, ${allProxies.length}条)`,
      );

      // 2. 保存每个国家前N个代理（带序号）
      await fs.promises.writeFile(
        OUTPUT_FILE,
        limitedProxies.join("\n"),
        "utf8",
      );
      console.log(
        `💾 已保存: ${OUTPUT_FILE} (每个国家前${LIMIT_PER_COUNTRY}个, ${limitedProxies.length}条)`,
      );

      // 按国家分组统计
      const groups = groupByCountry(validProxyObjects);
      console.log("\n📊 各国代理数量:");
      Object.keys(groups)
        .sort()
        .forEach((country) => {
          const count = groups[country].length;
          const emoji = groups[country][0]?.emoji || "";
          const limited = Math.min(count, LIMIT_PER_COUNTRY);
          if (count >= LIMIT_PER_COUNTRY) {
            console.log(
              `  ✅ ${emoji} ${country}: 共${count}个 (输出前${limited}个)`,
            );
          } else {
            console.log(
              `  ⚠️ ${emoji} ${country}: 共${count}个 (数量不足${LIMIT_PER_COUNTRY}，不输出)`,
            );
          }
        });

      console.log(
        `\n📋 前10个可用 Proxyip（每个国家前${LIMIT_PER_COUNTRY}个）:`,
      );
      limitedProxies.slice(0, 10).forEach((proxy, index) => {
        console.log(`  ${index + 1}. ${proxy}`);
      });

      if (limitedProxies.length > 10) {
        console.log(`  ... 共${limitedProxies.length}条`);
      }

      // 显示每个国家的序号范围示例
      console.log("\n📋 各国输出示例:");
      Object.keys(groups)
        .sort()
        .slice(0, 5)
        .forEach((country) => {
          const group = groups[country];
          const emoji = group[0]?.emoji || "";
          const first = group[0];
          if (group.length >= LIMIT_PER_COUNTRY) {
            const last = group[LIMIT_PER_COUNTRY - 1];
            const outputCount = LIMIT_PER_COUNTRY;
            console.log(
              `  ✅ ${emoji} ${country}: 输出${outputCount}个 (${first.ipPort}#${emoji} ${country}1 至 ${last.ipPort}#${emoji} ${country}${outputCount})`,
            );
          } else {
            console.log(
              `  ⚠️ ${emoji} ${country}: 共${group.length}个 (不足${LIMIT_PER_COUNTRY}，已过滤)`,
            );
          }
        });
    } else {
      console.log("\n⚠️ 未找到可用 Proxyip，不保存文件");
    }

    console.log("\n✨ 检测完成\n");
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ 程序异常: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}
// 执行主函数
main();
