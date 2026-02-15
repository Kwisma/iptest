import { promises as fs } from "fs";
import net from "net";
import tls from "tls";

const INPUT_FILE = "ip_all.txt";
const OUTPUT_FILE_ALL = "proxyip_all.txt";
const OUTPUT_FILE_TOP5 = "proxyip_top5.txt";
const FILTER_STRING = "#🇯🇵日本";
const CONCURRENCY_LIMIT = 100; // 大幅提升并发数
const TIMEOUT_MS = 3000; // 缩短超时时间
const TCP_TIMEOUT_MS = 1000; // TCP连接超时
const TOP5_LIMIT = 5;

// 自定义TCP连接池
class ConnectionPool {
  constructor() {
    this.connections = new Map(); // ip:port -> {socket, lastUsed, tlsSocket}
    this.maxIdleTime = 30000; // 30秒空闲回收
  }

  async getConnection(ip, port, useTLS = true) {
    const key = `${ip}:${port}`;
    let conn = this.connections.get(key);

    // 如果有可用连接且未关闭
    if (conn && !conn.socket.destroyed) {
      conn.lastUsed = Date.now();

      if (useTLS && !conn.tlsSocket) {
        // 升级到TLS
        conn.tlsSocket = tls.connect({
          socket: conn.socket,
          servername: "speed.cloudflare.com",
          rejectUnauthorized: false,
        });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("TLS握手超时")),
            5000,
          );
          conn.tlsSocket.once("secureConnect", () => {
            clearTimeout(timeout);
            resolve();
          });
          conn.tlsSocket.once("error", reject);
        });
      }

      return conn;
    }

    // 创建新连接
    const socket = net.createConnection({
      host: ip,
      port: port,
      timeout: TCP_TIMEOUT_MS,
    });

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
      };

      const onConnect = () => {
        cleanup();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const onTimeout = () => {
        cleanup();
        reject(new Error("TCP连接超时"));
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });

    socket.setKeepAlive(true, 60000);
    socket.setNoDelay(true); // 禁用Nagle算法，降低延迟

    conn = {
      socket,
      tlsSocket: null,
      lastUsed: Date.now(),
    };

    if (useTLS) {
      conn.tlsSocket = tls.connect({
        socket: socket,
        servername: "speed.cloudflare.com",
        rejectUnauthorized: false,
      });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("TLS握手超时")),
          5000,
        );
        conn.tlsSocket.once("secureConnect", () => {
          clearTimeout(timeout);
          resolve();
        });
        conn.tlsSocket.once("error", reject);
      });
    }

    this.connections.set(key, conn);

    // 清理空闲连接
    this.cleanup();

    return conn;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, conn] of this.connections.entries()) {
      if (now - conn.lastUsed > this.maxIdleTime) {
        if (conn.tlsSocket) conn.tlsSocket.destroy();
        if (conn.socket) conn.socket.destroy();
        this.connections.delete(key);
      }
    }
  }

  // 主动释放连接
  release(ip, port) {
    const key = `${ip}:${port}`;
    const conn = this.connections.get(key);
    if (conn) {
      conn.lastUsed = Date.now(); // 更新最后使用时间，不关闭
    }
  }

  // 强制关闭所有连接
  destroy() {
    for (const conn of this.connections.values()) {
      if (conn.tlsSocket) conn.tlsSocket.destroy();
      if (conn.socket) conn.socket.destroy();
    }
    this.connections.clear();
  }
}

// 全局连接池
const connectionPool = new ConnectionPool();

/**
 * 发送HTTP/1.1请求的原始数据
 */
async function sendHttpRequest(socket, host, path = "/cdn-cgi/trace") {
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Connection: keep-alive",
    "Accept: */*",
    "Accept-Encoding: identity", // 禁用压缩，避免解包开销
    "",
    "",
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("请求超时"));
    }, TIMEOUT_MS);

    let buffer = Buffer.alloc(0);
    let headersEnd = -1;
    let contentLength = -1;
    let isChunked = false;
    let bodyStart = 0;

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // 查找headers结束位置
      if (headersEnd === -1) {
        headersEnd = buffer.indexOf("\r\n\r\n");
        if (headersEnd !== -1) {
          const headers = buffer.slice(0, headersEnd).toString();

          // 检查状态码
          if (!headers.startsWith("HTTP/1.1 200")) {
            cleanup();
            reject(new Error(`非200状态码`));
            return;
          }

          // 解析Content-Length
          const clMatch = headers.match(/content-length: (\d+)/i);
          if (clMatch) {
            contentLength = parseInt(clMatch[1], 10);
          }

          // 检查是否是chunked编码
          isChunked = headers
            .toLowerCase()
            .includes("transfer-encoding: chunked");

          bodyStart = headersEnd + 4;
        }
      }

      // 如果已经找到headers，检查body是否完整
      if (headersEnd !== -1) {
        const bodyBuffer = buffer.slice(bodyStart);

        if (contentLength > 0 && bodyBuffer.length >= contentLength) {
          // 固定长度响应
          const body = bodyBuffer.slice(0, contentLength).toString();
          cleanup();
          resolve(body);
        } else if (isChunked) {
          // chunked编码响应
          if (bodyBuffer.slice(-5).toString() === "0\r\n\r\n") {
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
      reject(err);
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

    socket.write(request);
  });
}

/**
 * 判断是否为IPv6地址
 */
const isIPv6 = (ip) => net.isIPv6(ip);

/**
 * 从trace响应中提取ip字段
 */
const extractIpFromTrace = (traceText) => {
  const match = traceText.match(/^ip=(.+)$/m);
  return match ? match[1] : null;
};

/**
 * 判断代理是否包含指定的过滤字符串
 */
const isFilteredProxy = (proxyLine) => {
  return proxyLine.includes(FILTER_STRING);
};

/**
 * 解析代理行，提取IP和端口
 */
const parseProxyLine = (proxyLine) => {
  const trimmed = proxyLine.trim();
  if (!trimmed) return null;
  const [ipPort] = trimmed.split("#");
  return ipPort.trim();
};

/**
 * 提取代理行的标识符（#后面的部分）
 */
const extractProxyTag = (proxyLine) => {
  const trimmed = proxyLine.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("#");
  return parts.length > 1 ? `#${parts[1]}` : null;
};

/**
 * 提取标签的基础部分（去掉末尾的数字）
 */
const extractBaseTag = (tag) => {
  return tag.replace(/\d+$/, "");
};

/**
 * 暴力复用方式测试代理
 */
async function checkProxy(proxyLine) {
  const cleanIpPort = parseProxyLine(proxyLine);
  if (!cleanIpPort) return null;

  const [ip, portStr] = cleanIpPort.split(":");
  const port = parseInt(portStr, 10);

  try {
    // 1. 获取复用连接（强制TLS）
    const conn = await connectionPool.getConnection(ip, port, true);

    // 2. 在已建立的连接上发送请求
    const traceData = await sendHttpRequest(
      conn.tlsSocket || conn.socket,
      "speed.cloudflare.com",
      "/cdn-cgi/trace",
    );

    // 3. 提取出站IP
    const outboundIp = extractIpFromTrace(traceData);

    if (!outboundIp) {
      console.log(`❌ ${cleanIpPort} - 无法提取IP`);
      connectionPool.release(ip, port);
      return null;
    }

    if (isIPv6(outboundIp)) {
      console.log(`❌ ${cleanIpPort} - 出站IPv6: ${outboundIp}`);
      connectionPool.release(ip, port);
      return null;
    }

    console.log(`✅ ${cleanIpPort} - 出站IPv4: ${outboundIp}`);

    // 4. 释放连接回池
    connectionPool.release(ip, port);

    return {
      original: proxyLine,
      ipPort: cleanIpPort,
      tag: extractProxyTag(proxyLine),
      baseTag: extractBaseTag(extractProxyTag(proxyLine) || ""),
    };
  } catch (error) {
    console.log(`❌ ${cleanIpPort} - 错误: ${error.message}`);
    // 出错的连接会自动关闭，不需要特殊处理
    return null;
  }
}

/**
 * 按基础标签分组代理
 */
const groupByBaseTag = (proxies) => {
  const groups = {};
  proxies.forEach((proxy) => {
    const baseTag = proxy.baseTag;
    if (!groups[baseTag]) {
      groups[baseTag] = [];
    }
    groups[baseTag].push(proxy);
  });
  return groups;
};

/**
 * 重新格式化代理行，按标签分组内部重新编号
 */
const reorderProxies = (validProxyObjects) => {
  const groups = groupByBaseTag(validProxyObjects);
  const reordered = [];

  Object.keys(groups)
    .sort()
    .forEach((baseTag) => {
      const groupProxies = groups[baseTag];
      groupProxies.forEach((proxy, index) => {
        const newProxyLine = `${proxy.ipPort}${baseTag}${index + 1}`;
        reordered.push(newProxyLine);
      });
    });

  return reordered;
};

/**
 * 筛选每个地区前N个代理
 */
const selectTopNPerGroup = (validProxyObjects, limit) => {
  const groups = groupByBaseTag(validProxyObjects);
  const selected = [];

  Object.keys(groups)
    .sort()
    .forEach((baseTag) => {
      const groupProxies = groups[baseTag];
      const topN = groupProxies.slice(0, limit);

      topN.forEach((proxy, index) => {
        const newProxyLine = `${proxy.ipPort}${baseTag}${index + 1}`;
        selected.push(newProxyLine);
      });
    });

  return selected;
};

/**
 * 并发控制处理器（使用连接池复用）
 */
async function processBatch(items, concurrency, processor) {
  const results = [];
  const total = items.length;
  let completed = 0;

  // 使用工作池模式
  const workers = Array(concurrency)
    .fill()
    .map(async () => {
      while (items.length > 0) {
        const item = items.shift();
        if (!item) break;

        const result = await processor(item);
        if (result) results.push(result);

        completed++;
        if (completed % 10 === 0 || completed === total) {
          console.log(
            `📊 进度: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`,
          );
        }
      }
    });

  await Promise.all(workers);
  return results;
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log("📖 读取代理列表...");

    const content = await fs.readFile(INPUT_FILE, "utf8");
    const allLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    console.log(`📊 共找到 ${allLines.length} 个代理`);

    const filteredProxies = FILTER_STRING
      ? allLines.filter(isFilteredProxy)
      : allLines;

    console.log(`🔍 过滤条件: ${FILTER_STRING}`);
    console.log(`📊 符合条件的代理: ${filteredProxies.length} 个\n`);

    if (filteredProxies.length === 0) {
      console.log("⚠️ 没有找到符合条件的代理");
      return;
    }

    console.log("🚀 开始测试代理（连接池复用模式）...\n");

    // 打乱顺序，避免集中测试同一IP段
    const shuffled = [...filteredProxies].sort(() => Math.random() - 0.5);

    const validProxyObjects = await processBatch(
      shuffled,
      CONCURRENCY_LIMIT,
      checkProxy,
    );

    // 清理连接池
    connectionPool.destroy();

    console.log("\n📝 结果统计:");
    console.log(`✅ 可用代理: ${validProxyObjects.length}`);
    console.log(
      `❌ 无效代理: ${filteredProxies.length - validProxyObjects.length}`,
    );

    const groups = groupByBaseTag(validProxyObjects);
    console.log("\n📊 分组统计:");
    Object.keys(groups)
      .sort()
      .forEach((baseTag) => {
        console.log(`  ${baseTag}: ${groups[baseTag].length} 个代理`);
      });

    const reorderedProxies = reorderProxies(validProxyObjects);
    const top5Proxies = selectTopNPerGroup(validProxyObjects, TOP5_LIMIT);

    if (reorderedProxies.length > 0) {
      await fs.writeFile(OUTPUT_FILE_ALL, reorderedProxies.join("\n"), "utf8");
      console.log(
        `\n💾 所有代理已保存到: ${OUTPUT_FILE_ALL} (共 ${reorderedProxies.length} 个)`,
      );
    }

    if (top5Proxies.length > 0) {
      await fs.writeFile(OUTPUT_FILE_TOP5, top5Proxies.join("\n"), "utf8");
      console.log(
        `💾 每个地区前${TOP5_LIMIT}个代理已保存到: ${OUTPUT_FILE_TOP5} (共 ${top5Proxies.length} 个)`,
      );

      console.log("\n📋 每个地区前5个代理:");
      top5Proxies.forEach((proxy, index) => {
        console.log(`  ${index + 1}. ${proxy}`);
      });

      const formattedProxies = reorderedProxies
        .map((proxy) => {
          const match = proxy.match(
            /^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+)#/,
          );
          return match ? match[1] : null;
        })
        .filter(Boolean);

      console.log("\n格式化：", JSON.stringify(formattedProxies));
      process.exit(0);
    } else {
      console.log("⚠️ 没有可用的代理，不保存文件");
    }
  } catch (error) {
    console.error("❌ 程序执行出错:", error);
    process.exit(1);
  }
}

// 执行主函数
main();
