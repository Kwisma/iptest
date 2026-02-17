/**
 * ============================================================================
 * Cloudflare CDN ProxyIP 检测工具 v4.0
 * ============================================================================
 * 
 * 功能说明：
 * 1. 从CSV文件读取代理IP列表
 * 2. 检测每个代理IP是否可用（通过请求 Cloudflare 的 /cdn-cgi/trace 接口）
 * 3. 获取出口IP的地理位置信息
 * 4. 按国家分组并输出结果
 * 
 * 核心特性：
 * - 连接池复用：大幅提升检测效率
 * - 并发控制：避免系统负载过高
 * - 自动重连：支持TCP/TLS连接复用
 * - 智能过滤：按IP版本（IPv4/IPv6）筛选
 * - 国家分组：每个国家输出指定数量的代理
 * 
 * 作者：优化版
 * 版本：v4.0
 * 最后更新：2024
 * ============================================================================
 */

import fs from "fs";
import net from "net";
import tls from "tls";

// ============================================================================
// 颜色定义
// ============================================================================

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  
  // 前景色
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  
  // 亮色
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
};

// ============================================================================
// 配置常量模块
// ============================================================================

/** 输入CSV文件路径，包含代理IP和端口信息 */
const IPS_CSV = "../init.csv";

/** locations.json 文件路径，用于存储地理位置信息 */
const LOCATIONS_JSON = "locations.json";

/** 输出文件路径，保存每个国家前LIMIT_PER_COUNTRY个有效代理IP */
const OUTPUT_FILE = "ip_top5.txt";

/** 输出文件路径，保存所有有效代理IP（不限制数量） */
const OUTPUT_ALL = "ip_all.txt";

/** 设置代理IP的类型，支持 'ipv4'、'ipv6' 和 'all' */
const OUTPUT_TYPE = "ipv4";

/** 从哪里下载locations.json文件 */
const LOCATIONS_URL = "https://locations-adw.pages.dev";

/** 每个国家输出的代理数量 */
const LIMIT_PER_COUNTRY = 5;

/** 控制并发请求的最大数量，避免过高的并发造成负载过大 */
const CONCURRENCY_LIMIT = 200;

/** HTTP请求的超时设置，单位为毫秒 */
const TIMEOUT_MS = 3000;

/** TCP连接的超时时间，单位为毫秒 */
const TCP_TIMEOUT_MS = 2000;

/** TLS连接的超时时间，单位为毫秒 */
const TLS_TIMEOUT_MS = 2000;

// ============================================================================
// 日志系统
// ============================================================================

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  error: 2
};

/** 当前日志级别，可根据需要修改 */
const currentLogLevel = LOG_LEVELS.info;

/**
 * 带颜色的日志输出
 * @param {string} level - 日志级别
 * @param {string} message - 日志内容
 * @param {Object} data - 附加数据
 */
function log(level, message, data = null) {
  if (LOG_LEVELS[level] < currentLogLevel) return;
  
  const timestamp = new Date().toISOString().slice(11, 19);
  let colorPrefix = '';
  
  // 根据级别设置颜色
  switch(level) {
    case 'debug':
      colorPrefix = COLORS.dim + COLORS.cyan;
      break;
    case 'info':
      colorPrefix = COLORS.bright + COLORS.green;
      break;
    case 'error':
      colorPrefix = COLORS.bright + COLORS.red;
      break;
    default:
      colorPrefix = COLORS.reset;
  }
  
  const prefix = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${colorPrefix}[${level.toUpperCase()}]${COLORS.reset}`;
  
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/** 调试日志函数 */
const debug = (msg, data) => log('debug', msg, data);

/** 信息日志函数 */
const info = (msg, data) => log('info', msg, data);

/** 错误日志函数 */
const error = (msg, data) => log('error', msg, data);

/**
 * 成功日志 - 操作成功的提示
 * @param {string} message - 成功消息
 */
const success = (message) => {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefix = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${COLORS.bright + COLORS.green}[INFO]${COLORS.reset}`;
  console.log(`${prefix} ${COLORS.brightGreen}✅ ${message}${COLORS.reset}`);
};

/**
 * 失败日志 - 操作失败的提示
 * @param {string} message - 失败消息
 */
const fail = (message) => {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefix = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${COLORS.bright + COLORS.red}[INFO]${COLORS.reset}`;
  console.log(`${prefix} ${COLORS.brightRed}❌ ${message}${COLORS.reset}`);
};

/**
 * 进度日志 - 进度信息显示
 * @param {string} message - 进度消息
 */
const progress = (message) => {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefix = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${COLORS.bright + COLORS.magenta}[INFO]${COLORS.reset}`;
  console.log(`${prefix} ${COLORS.brightMagenta}📊 ${message}${COLORS.reset}`);
};

/**
 * 标题输出（不带时间戳，用于程序开头）
 * @param {string} message - 标题消息
 */
const title = (message) => {
  console.log(`${COLORS.bright}${message}${COLORS.reset}`);
};

/**
 * 分隔线输出
 */
const separator = () => {
  console.log(COLORS.dim + "=".repeat(70) + COLORS.reset);
};

// ============================================================================
// 全局错误处理模块
// ============================================================================

/** 可忽略的网络错误代码列表 */
const IGNORABLE_ERROR_CODES = new Set([
  "EHOSTUNREACH",   // 主机不可达
  "ECONNREFUSED",   // 连接被拒绝
  "ETIMEDOUT",      // 连接超时
  "ENETUNREACH",    // 网络不可达
  "EADDRNOTAVAIL",  // 地址不可用
  "ECONNRESET",     // 连接被重置
  "EPIPE",          // 管道破裂
  "ERR_SSL_BAD_RECORD_TYPE" // SSL错误记录类型
]);

/**
 * 检查错误是否可以被忽略
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否可忽略
 */
const isIgnorableError = (error) => {
  if (!error) return true;
  return IGNORABLE_ERROR_CODES.has(error.code) || 
         error.message?.includes("bad record type");
};

// 处理未捕获的异常
process.on("uncaughtException", (error) => {
  if (isIgnorableError(error)) return;
  error(`未捕获的异常: ${error.message}`);
  debug(error.stack);
});

// 处理未处理的Promise拒绝
process.on("unhandledRejection", (reason) => {
  if (isIgnorableError(reason)) return;
  error(`未处理的Promise拒绝: ${reason}`);
});

// ============================================================================
// 地理位置数据管理模块
// ============================================================================

/**
 * 检查locations.json文件是否存在，不存在则下载
 */
async function checkLocationsJson() {
  try {
    await fs.promises.access(LOCATIONS_JSON);
    info(`${LOCATIONS_JSON} 文件已存在`);
  } catch (error) {
    info(`${LOCATIONS_JSON} 文件不存在，正在下载...`);
    await downloadLocationsJson();
  }
}

/**
 * 下载地理位置JSON文件
 * @throws {Error} 下载失败时抛出错误
 */
async function downloadLocationsJson() {
  try {
    const response = await fetch(LOCATIONS_URL);
    if (!response.ok) {
      throw new Error(`下载失败，HTTP状态码: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(LOCATIONS_JSON, Buffer.from(buffer));
    success(`${LOCATIONS_JSON} 下载并保存完成`);
  } catch (error) {
    throw new Error(`下载过程中发生错误: ${error.message}`);
  }
}

/**
 * 读取locations.json文件并解析为Map
 * @returns {Promise<Map>} COLO代码到位置信息的映射
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

    info(`加载完成: ${LOCATIONS_JSON} (${coloMap.size}个数据中心)`);
    debug(`COLO列表: ${Array.from(coloMap.keys()).join(', ')}`);
    return coloMap;
  } catch (error) {
    error(`读取失败 ${LOCATIONS_JSON}: ${error.message}`);
    process.exit(1);
  }
}

// ============================================================================
// CSV解析模块
// ============================================================================

/**
 * 读取并解析CSV文件中的代理IP
 * @returns {Promise<string[]>} 代理IP列表 (格式: ip:port)
 */
async function readIpsCsv() {
  try {
    const content = await fs.promises.readFile(IPS_CSV, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    if (lines.length === 0) {
      throw new Error("CSV文件为空");
    }

    // 解析CSV头，找出IP和端口所在的列
    const headers = lines[0].split(",").map((h) => h.trim());
    const ipIndex = headers.findIndex(
      (h) => h.includes("IP") || h.includes("ip")
    );
    const portIndex = headers.findIndex(
      (h) => h.includes("端口") || h.includes("port")
    );

    if (ipIndex === -1 || portIndex === -1) {
      throw new Error("CSV文件中未找到IP地址或端口号列");
    }

    debug(`解析CSV: IP列[${ipIndex}], 端口列[${portIndex}]`);

    const proxyList = [];
    for (let i = 1; i < lines.length; i++) {
      const columns = lines[i].split(",");
      if (columns.length > Math.max(ipIndex, portIndex)) {
        const ip = columns[ipIndex]?.replace(/"/g, "").trim();
        const port = columns[portIndex]?.replace(/"/g, "").trim();

        if (ip && port && net.isIP(ip) && !isNaN(parseInt(port))) {
          proxyList.push(`${ip}:${port}`);
        } else {
          debug(`跳过无效行 ${i+1}: IP=${ip}, Port=${port}`);
        }
      }
    }

    info(`加载完成: ${proxyList.length} 个IP (共${lines.length-1}行)`);
    debug(`IP列表: ${proxyList.slice(0, 5).join(', ')}${proxyList.length > 5 ? '...' : ''}`);
    return proxyList;
  } catch (error) {
    error(`读取失败 ${IPS_CSV}: ${error.message}`);
    process.exit(1);
  }
}

// ============================================================================
// 连接池模块 - 核心性能优化组件
// ============================================================================

/**
 * 连接池类 - 管理和复用TCP/TLS连接
 * 
 * 设计原理：
 * 1. 使用Map存储连接，键为"ip:port"
 * 2. 支持连接升级（TCP -> TLS）
 * 3. 自动清理空闲连接
 * 4. 统计命中率用于性能分析
 */
class ConnectionPool {
  constructor() {
    /** 存储所有连接 { key: { socket, tlsSocket, lastUsed } } */
    this.connections = new Map();
    
    /** 最大空闲时间（毫秒） */
    this.maxIdleTime = 30000;
    
    /** 连接池最大大小 */
    this.maxPoolSize = 500;
    
    /** 统计信息 */
    this.stats = {
      hits: 0,      // 命中次数
      misses: 0,    // 未命中次数
      created: 0,   // 创建连接数
      closed: 0,    // 关闭连接数
      errors: 0,    // 错误次数
    };
    
    debug("连接池初始化完成");
  }

  /**
   * 获取或创建连接
   * @param {string} ip - IP地址
   * @param {number} port - 端口
   * @param {boolean} useTLS - 是否使用TLS
   * @returns {Promise<Object>} 连接对象
   */
  async getConnection(ip, port, useTLS = true) {
    const key = `${ip}:${port}`;
    let conn = this.connections.get(key);

    // 命中连接池 - 连接存在且未销毁
    if (conn && !conn.socket.destroyed) {
      conn.lastUsed = Date.now();
      this.stats.hits++;
      debug(`连接池命中: ${key}`);

      // 如果需要TLS但当前只有TCP连接，升级连接
      if (useTLS && !conn.tlsSocket) {
        debug(`升级连接到TLS: ${key}`);
        try {
          conn.tlsSocket = await this.upgradeToTLS(conn.socket);
        } catch (error) {
          this.stats.errors++;
          this.connections.delete(key);
          debug(`TLS升级失败: ${key} - ${error.message}`);
          throw error;
        }
      }

      return conn;
    }

    // 未命中，创建新连接
    this.stats.misses++;
    debug(`连接池未命中，创建新连接: ${key}`);

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
        const closed = this.cleanup(true);
        debug(`连接池超过大小限制，清理了${closed}个连接`);
      }

      return conn;
    } catch (error) {
      this.stats.errors++;
      debug(`创建连接失败: ${key} - ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建TCP连接
   * @param {string} ip - IP地址
   * @param {number} port - 端口
   * @returns {Promise<net.Socket>} TCP Socket
   */
  createTCPSocket(ip, port) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let isDone = false;

      // 错误处理函数
      const onError = (err) => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TCP连接失败: ${err.message}`));
      };

      // 连接成功处理
      const onConnect = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        socket.setKeepAlive(true, 60000);
        socket.setNoDelay(true);
        resolve(socket);
      };

      // 超时处理
      const onTimeout = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TCP连接超时 (${TCP_TIMEOUT_MS}ms)`));
      };

      // 清理事件监听
      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
      };

      // 注册事件监听
      socket.once("error", onError);
      socket.once("connect", onConnect);
      socket.once("timeout", onTimeout);
      socket.setTimeout(TCP_TIMEOUT_MS);

      // 发起连接
      socket.connect(parseInt(port), ip);
    });
  }

  /**
   * 将TCP连接升级到TLS
   * @param {net.Socket} socket - TCP Socket
   * @returns {Promise<tls.TLSSocket>} TLS Socket
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

      // 错误处理
      const onError = (err) => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TLS握手失败: ${err.message}`));
      };

      // 安全连接建立处理
      const onSecureConnect = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        tlsSocket.setKeepAlive(true, 60000);
        tlsSocket.setNoDelay(true);
        resolve(tlsSocket);
      };

      // 超时处理
      const onTimeout = () => {
        if (isDone) return;
        isDone = true;
        cleanup();
        reject(new Error(`TLS握手超时 (${TLS_TIMEOUT_MS}ms)`));
      };

      // 清理事件监听
      const cleanup = () => {
        tlsSocket.removeListener("secureConnect", onSecureConnect);
        tlsSocket.removeListener("error", onError);
        tlsSocket.removeListener("timeout", onTimeout);
      };

      // 注册事件监听
      tlsSocket.once("error", onError);
      tlsSocket.once("secureConnect", onSecureConnect);
      tlsSocket.once("timeout", onTimeout);
    });
  }

  /**
   * 释放连接回池（更新最后使用时间）
   * @param {string} ip - IP地址
   * @param {number} port - 端口
   */
  release(ip, port) {
    const key = `${ip}:${port}`;
    const conn = this.connections.get(key);
    if (conn) {
      conn.lastUsed = Date.now();
      debug(`释放连接: ${key}`);
    }
  }

  /**
   * 清理空闲连接
   * @param {boolean} force - 是否强制清理（用于限制池大小）
   * @returns {number} 关闭的连接数
   */
  cleanup(force = false) {
    const now = Date.now();
    let closed = 0;

    for (const [key, conn] of this.connections.entries()) {
      const isIdle = now - conn.lastUsed > this.maxIdleTime;
      const needShrink = force && this.connections.size > this.maxPoolSize;

      if (isIdle || needShrink) {
        // 销毁TLS连接
        if (conn.tlsSocket) {
          try { conn.tlsSocket.destroy(); } catch (e) {}
        }
        // 销毁TCP连接
        if (conn.socket) {
          try { conn.socket.destroy(); } catch (e) {}
        }
        this.connections.delete(key);
        closed++;
        debug(`清理连接: ${key} (空闲: ${isIdle}, 强制: ${needShrink})`);
      }
    }

    this.stats.closed += closed;
    return closed;
  }

  /**
   * 关闭所有连接并输出统计信息
   */
  destroy() {
    const count = this.cleanup(true);
    this.stats.closed += count;

    info("📊 连接池统计:");
    info(`  ✅ 命中: ${this.stats.hits}`);
    info(`  ❌ 未命中: ${this.stats.misses}`);
    info(`  📦 创建: ${this.stats.created}`);
    info(`  🗑️ 关闭: ${this.stats.closed}`);
    info(`  ⚠️ 错误: ${this.stats.errors}`);
    info(`  💾 剩余: ${this.connections.size}`);
  }
}

/** 全局连接池实例 */
const connectionPool = new ConnectionPool();

// ============================================================================
// HTTP请求模块
// ============================================================================

/**
 * 带超时的连接获取
 * @param {string} ip - IP地址
 * @param {number} port - 端口
 * @param {boolean} useTLS - 是否使用TLS
 * @returns {Promise<Object>} 连接对象
 */
async function getConnectionWithTimeout(ip, port, useTLS = true) {
  return Promise.race([
    connectionPool.getConnection(ip, port, useTLS),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`获取连接超时 (${TCP_TIMEOUT_MS}ms)`)),
        TCP_TIMEOUT_MS + 500
      )
    ),
  ]);
}

/**
 * 发送原始HTTP/1.1请求
 * @param {net.Socket|tls.TLSSocket} socket - Socket连接
 * @param {string} host - 主机名
 * @param {string} path - 请求路径
 * @returns {Promise<string>} 响应体
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

    // 数据接收处理
    const onData = (chunk) => {
      if (resolved) return;
      buffer = Buffer.concat([buffer, chunk]);

      // 解析HTTP头部
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
          if (clMatch) contentLength = parseInt(clMatch[1], 10);
          isChunked = headers.toLowerCase().includes("transfer-encoding: chunked");
          bodyStart = headersEnd + 4;
        }
      }

      // 检查响应体是否完整
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
      debug(`发送HTTP请求到 ${host}${path}`);
    } catch (err) {
      cleanup();
      reject(new Error(`写入请求失败: ${err.message}`));
    }
  });
}

// ============================================================================
// 工具函数模块
// ============================================================================

/**
 * 判断是否为IPv6地址
 * @param {string} ip - IP地址
 * @returns {boolean} 是否为IPv6
 */
const isIPv6 = (ip) => net.isIPv6(ip);

/**
 * 从trace响应中提取ip和colo字段
 * @param {string} traceText - trace响应文本
 * @returns {Object} 包含ip和colo的对象
 */
const extractFromTrace = (traceText) => {
  const result = { ip: null, colo: null };
  if (!traceText) return result;

  const lines = traceText.split("\n");
  lines.forEach((line) => {
    const index = line.indexOf("=");
    if (index > 0) {
      const key = line.substring(0, index).trim();
      const value = line.substring(index + 1).trim();
      if (key && value) result[key] = value;
    }
  });

  return result;
};

/**
 * 按国家分组代理
 * @param {Array} proxies - 代理对象数组
 * @returns {Object} 按国家分组的代理
 */
const groupByCountry = (proxies) => {
  const groups = {};
  proxies.forEach((proxy) => {
    const country = proxy.country;
    if (!groups[country]) groups[country] = [];
    groups[country].push(proxy);
  });
  return groups;
};

/**
 * 为代理添加序号
 * @param {Array} validProxyObjects - 有效代理对象数组
 * @param {number} limitPerCountry - 每个国家限制数量
 * @returns {Object} 包含all和limited两个版本的代理列表
 */
const addSequentialNumbers = (validProxyObjects, limitPerCountry = 5) => {
  const groups = groupByCountry(validProxyObjects);
  const allNumberedProxies = [];
  const limitedNumberedProxies = [];

  Object.keys(groups).sort().forEach((country) => {
    const groupProxies = groups[country];

    if (groupProxies.length >= limitPerCountry) {
      // 全部代理
      groupProxies.forEach((proxy, index) => {
        allNumberedProxies.push(
          `${proxy.ipPort}#${proxy.emoji}${proxy.country}${index + 1}`
        );
      });

      // 限制数量的代理
      groupProxies.slice(0, limitPerCountry).forEach((proxy, index) => {
        limitedNumberedProxies.push(
          `${proxy.ipPort}#${proxy.emoji}${proxy.country}${index + 1}`
        );
      });
    }
  });

  return { all: allNumberedProxies, limited: limitedNumberedProxies };
};

// ============================================================================
// 代理检测核心模块
// ============================================================================

/**
 * 检测单个代理
 * @param {string} proxyAddress - 代理地址 (ip:port)
 * @param {Map} coloMap - COLO位置映射
 * @param {string} ipVersion - IP版本过滤 ('ipv4', 'ipv6', 'all')
 * @returns {Promise<Object|null>} 检测结果对象或null
 */
async function checkProxy(proxyAddress, coloMap, ipVersion = "all") {
  const parts = proxyAddress.split(":");
  if (parts.length !== 2) return null;

  const ip = parts[0];
  const port = parseInt(parts[1], 10);
  const startTime = Date.now();

  let conn = null;
  let hasConnection = false;

  try {
    // 获取复用连接
    conn = await getConnectionWithTimeout(ip, port, true);
    hasConnection = true;

    // 发送HTTP请求
    const traceData = await sendHttpRequest(
      conn.tlsSocket || conn.socket,
      "speed.cloudflare.com",
      "/cdn-cgi/trace"
    );

    const elapsed = Date.now() - startTime;
    const { ip: outboundIp, colo } = extractFromTrace(traceData);

    if (!outboundIp) {
      debug(`${proxyAddress} 无IP信息 (${elapsed}ms)`);
      connectionPool.release(ip, port);
      return null;
    }

    // 获取位置信息
    const locationInfo = colo && coloMap.has(colo) ? coloMap.get(colo) : null;
    const countryDisplay = locationInfo ? 
      `${locationInfo.emoji} ${locationInfo.country}` : 
      `COLO:${colo || "未知"}`;

    const isOutboundIPv6 = isIPv6(outboundIp);

    // IP版本过滤
    if (ipVersion === "ipv4" && isOutboundIPv6) {
      debug(`${proxyAddress} IPv6出口 ${countryDisplay} (${elapsed}ms) - 已过滤`);
      connectionPool.release(ip, port);
      return null;
    }

    if (ipVersion === "ipv6" && !isOutboundIPv6) {
      debug(`${proxyAddress} IPv4出口 ${countryDisplay} (${elapsed}ms) - 已过滤`);
      connectionPool.release(ip, port);
      return null;
    }

    // 验证位置信息
    if (!colo || !coloMap.has(colo)) {
      debug(`${proxyAddress} ${isOutboundIPv6 ? 'IPv6' : 'IPv4'}出口 ${countryDisplay} (${elapsed}ms) - 位置未知`);
      connectionPool.release(ip, port);
      return null;
    }

    // 有效代理
    success(`${proxyAddress} ${isOutboundIPv6 ? 'IPv6' : 'IPv4'}出口 ${countryDisplay} (${elapsed}ms)`);
    connectionPool.release(ip, port);

    return {
      ipPort: proxyAddress,
      country: locationInfo.country,
      emoji: locationInfo.emoji,
      colo: colo,
      timestamp: Date.now(),
      ipVersion: isOutboundIPv6 ? "ipv6" : "ipv4",
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;

    if (!error.message.includes("超时")) {
      debug(`${proxyAddress} 错误: ${error.message.substring(0, 30)} (${elapsed}ms)`);
    }

    if (hasConnection) connectionPool.release(ip, port);
    return null;
  }
}

// ============================================================================
// 并发控制模块
// ============================================================================

/**
 * 批量处理代理检测
 * @param {Array} items - 代理地址数组
 * @param {number} concurrency - 并发数
 * @param {Function} processor - 处理函数
 * @param {Map} coloMap - COLO位置映射
 * @returns {Promise<Array>} 检测结果数组
 */
async function processBatch(items, concurrency, processor, coloMap) {
  const results = [];
  const total = items.length;
  let completed = 0;
  let currentIndex = 0;

  info(`🚀 开始检测 ${total} 个ProxyIP (并发${concurrency}, 连接池复用模式)`);

  const worker = async () => {
    while (true) {
      const index = currentIndex++;
      if (index >= total) break;

      const item = items[index];
      try {
        const result = await processor(item, coloMap);
        if (result) results.push(result);
      } catch (error) {
        debug(`处理 ${item} 时发生错误: ${error.message}`);
      }

      completed++;

      // 进度显示
      if (completed % 10 === 0 || completed === total) {
        const percent = ((completed / total) * 100).toFixed(1);
        const hitRate = connectionPool.stats.hits + connectionPool.stats.misses > 0
          ? ((connectionPool.stats.hits / 
             (connectionPool.stats.hits + connectionPool.stats.misses)) * 100).toFixed(1)
          : "0.0";

        progress(
          `进度: ${completed}/${total} (${percent}%) | ` +
          `有效: ${results.length} | ` +
          `命中: ${hitRate}% | ` +
          `池: ${connectionPool.connections.size}`
        );
      }
    }
  };

  const workerCount = Math.min(concurrency, total);
  const workers = Array(workerCount).fill().map(() => worker());
  await Promise.all(workers);
  
  return results;
}

/**
 * 打印统计摘要
 * @param {Array} proxyAddresses - 所有代理地址
 * @param {Array} validProxies - 有效代理
 * @param {number} elapsedTime - 耗时(秒)
 */
function printSummary(proxyAddresses, validProxies, elapsedTime) {
  const total = proxyAddresses.length;
  const valid = validProxies.length;
  const invalid = total - valid;
  const successRate = ((valid / total) * 100).toFixed(1);

  const hitRate = connectionPool.stats.hits + connectionPool.stats.misses > 0
    ? ((connectionPool.stats.hits / 
       (connectionPool.stats.hits + connectionPool.stats.misses)) * 100).toFixed(1)
    : "0.0";

  separator();
  info("📊 检测完成统计");
  separator();
  info(`  总 ProxyIP 数:     ${total}`);
  info(`  ✅ 可用:           ${valid} (${successRate}%)`);
  info(`  ❌ 无效:           ${invalid}`);
  info(`  ⏱️ 耗时:           ${elapsedTime.toFixed(1)}s`);
  info(`  ⚡ 平均速度:        ${(total / elapsedTime).toFixed(1)}个/秒`);
  info(`  🎯 连接池命中率:    ${hitRate}%`);
  info(`  💾 连接池大小:      ${connectionPool.connections.size}个`);
  separator();
}

/**
 * 启动连接池清理定时器
 */
function startCleanupTimer() {
  setInterval(() => {
    const before = connectionPool.connections.size;
    const closed = connectionPool.cleanup();
    if (closed > 0) {
      debug(`连接池清理: ${before} → ${connectionPool.connections.size} (关闭${closed}个空闲连接)`);
    }
  }, 10000);
}

// ============================================================================
// 主函数
// ============================================================================

/**
 * 主程序入口
 */
async function main() {
  // 显示程序标题
  console.log("");
  title("=".repeat(70));
  title("🚀 Cloudflare CDN ProxyIP 检测工具 v4.0 - 连接池复用模式");
  title("=".repeat(70));
  console.log("");

  const startTime = Date.now();

  try {
    // 启动连接池清理
    startCleanupTimer();

    // 读取CSV文件
    info("📖 读取配置文件...");
    const proxyAddresses = await readIpsCsv();

    if (proxyAddresses.length === 0) {
      info("⚠️ 没有IP地址，程序退出");
      return;
    }

    // 加载地理位置数据
    await checkLocationsJson();
    const coloMap = await readLocationsJson();

    // 打乱顺序，避免集中测试同一IP段
    const shuffled = [...proxyAddresses].sort(() => Math.random() - 0.5);

    // 批量检测代理
    const validProxyObjects = await processBatch(
      shuffled,
      CONCURRENCY_LIMIT,
      (proxy, map) => checkProxy(proxy, map, OUTPUT_TYPE),
      coloMap
    );

    // 关闭连接池
    connectionPool.destroy();

    // 计算总耗时
    const totalTime = (Date.now() - startTime) / 1000;

    // 为代理添加序号
    const { all: allProxies, limited: limitedProxies } = addSequentialNumbers(
      validProxyObjects,
      LIMIT_PER_COUNTRY
    );

    // 打印统计摘要
    printSummary(proxyAddresses, validProxyObjects, totalTime);

    // 保存结果
    if (allProxies.length > 0) {
      // 保存全部代理
      await fs.promises.writeFile(OUTPUT_ALL, allProxies.join("\n"), "utf8");
      success(`已保存: ${OUTPUT_ALL} (全部代理, ${allProxies.length}条)`);

      // 保存每个国家前N个代理
      await fs.promises.writeFile(OUTPUT_FILE, limitedProxies.join("\n"), "utf8");
      success(`已保存: ${OUTPUT_FILE} (每个国家前${LIMIT_PER_COUNTRY}个, ${limitedProxies.length}条)`);

      // 按国家分组统计
      const groups = groupByCountry(validProxyObjects);
      info("\n📊 各国代理数量:");
      Object.keys(groups).sort().forEach((country) => {
        const count = groups[country].length;
        const emoji = groups[country][0]?.emoji || "";
        if (count >= LIMIT_PER_COUNTRY) {
          info(`  ✅ ${emoji} ${country}: 共${count}个 (输出前${LIMIT_PER_COUNTRY}个)`);
        } else {
          info(`  ⚠️ ${emoji} ${country}: 共${count}个 (数量不足${LIMIT_PER_COUNTRY}，不输出)`);
        }
      });

      // 显示前10个可用代理
      info(`\n📋 前10个可用ProxyIP（每个国家前${LIMIT_PER_COUNTRY}个）:`);
      limitedProxies.slice(0, 10).forEach((proxy, index) => {
        info(`  ${index + 1}. ${proxy}`);
      });

      if (limitedProxies.length > 10) {
        info(`  ... 共${limitedProxies.length}条`);
      }
    } else {
      info("\n⚠️ 未找到可用ProxyIP，不保存文件");
    }

    success("\n✨ 检测完成\n");
    process.exit(0);
  } catch (error) {
    error(`\n❌ 程序异常: ${error.message}`);
    debug(error.stack);
    process.exit(1);
  }
}

// 执行主函数
main();