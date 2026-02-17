/**
 * VLESS 代理服务器延迟测试工具
 *
 * 功能：测试多个IP地址的VLESS代理服务器连通性和延迟
 *
 * @author AI Assistant
 * @version 3.0.0
 * @license MIT
 */

// ==================== 模块导入 ====================
import fs from "fs";
import WebSocket from "ws";
import tls from "tls";
import constants from "constants";
import https from "https";
// ==================== 颜色定义 ====================

/** 终端颜色代码 */
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

// ==================== 配置常量 ====================

/** VLESS协议配置 */
const VLESS_CONFIG = {
  uuid: "00000000-0000-4000-8000-000000000000",
  sni: "sub.mot.ip-ddns.com",
  host: "sub.mot.ip-ddns.com",
  path: "/",
};

/** 测试配置 */
const TEST_CONFIG = {
  MAX_CONCURRENT: 50, // 最大并发连接数
  TESTS_PER_IP: 5, // 每个IP测试次数
  CONNECTION_TIMEOUT: 5000, // 连接超时(ms)
  RETRY_DELAY: 500, // 重试延迟(ms)
  LOG_LEVEL: "info", // 日志级别: debug/info/error
};

// ==================== 日志系统 ====================

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  error: 2,
};

const currentLogLevel = LOG_LEVELS[TEST_CONFIG.LOG_LEVEL] || 1;

/**
 * 带颜色的日志输出
 * @param {string} level - 日志级别
 * @param {string} message - 日志内容
 * @param {Object} data - 附加数据
 */
function log(level, message, data = null) {
  if (LOG_LEVELS[level] < currentLogLevel) return;

  const timestamp = new Date().toISOString().slice(11, 19);
  let colorPrefix = "";

  // 根据级别设置颜色
  switch (level) {
    case "debug":
      colorPrefix = COLORS.dim + COLORS.cyan;
      break;
    case "info":
      colorPrefix = COLORS.bright + COLORS.green;
      break;
    case "error":
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

// 便捷日志函数
const debug = (msg, data) => log("debug", msg, data);
const info = (msg, data) => log("info", msg, data);
const error = (msg, data) => log("error", msg, data);
// ==================== 全局变量 ====================
let globalECHConfig = null; // 全局ECH配置
// ==================== 状态管理 ====================

/** IP列表: {ip, port, location}[] */
let ipPortList = [];

/** 测试结果存储 */
let testResults = new Map(); // key: "ip:port" -> result对象

/** 测试进度跟踪 */
let completedTests = 0; // 已完成测试次数
let activeConnections = 0; // 当前活跃连接数
let nextTestIndex = 0; // 下一个待测试IP索引

// ==================== 工具函数 ====================
/**
 * 通过 DoH 获取 ECH 配置
 * @param {string} domain
 * @returns {Promise<Buffer|null>}
 */
async function getECHConfig(domain) {
  const url = `https://doh.cmliussss.com/CMLiussss?name=${domain}&type=HTTPS`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          accept: "application/dns-json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);

            if (!json.Answer) {
              return resolve(null);
            }

            for (const record of json.Answer) {
              if (record.type === 65) {
                // HTTPS RR
                const ech = parseECHFromHTTPS(record.data);
                if (ech) {
                  return resolve(ech);
                }
              }
            }

            resolve(null);
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    req.on("error", reject);
  });
}

/**
 * 解析 RFC 3597 格式 HTTPS 记录
 * @param {string} dataStr
 */
function parseECHFromHTTPS(dataStr) {
  // 格式示例：
  // "\# 136 00 01 00 00 01 ...."
  if (!dataStr.startsWith("\\#")) return null;

  const hex = dataStr.split(" ").slice(2).join("");
  const buf = Buffer.from(hex, "hex");

  let offset = 0;

  // priority (2 bytes)
  offset += 2;

  // target name (DNS name format)
  while (buf[offset] !== 0x00) {
    offset += buf[offset] + 1;
  }
  offset += 1;

  // 读取 SvcParams
  while (offset < buf.length) {
    const key = buf.readUInt16BE(offset);
    offset += 2;

    const len = buf.readUInt16BE(offset);
    offset += 2;

    const value = buf.slice(offset, offset + len);
    offset += len;

    // echconfig 的 key 是 5
    if (key === 5) {
      return value;
    }
  }

  return null;
}
/**
 * UUID转字节数组
 * @param {string} uuid - 标准UUID格式
 * @returns {Uint8Array} 16字节数组
 */
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 32; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 计算平均延迟
 * @param {number[]} latencies - 延迟数组
 * @returns {number} 平均延迟
 */
function calculateAverage(latencies) {
  if (latencies.length === 0) return 0;
  return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
}

/**
 * 生成WebSocket Key
 * @returns {string} Base64编码的16字节随机数
 */
function generateWebSocketKey() {
  return Buffer.from(
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
  ).toString("base64");
}

/**
 * 根据延迟获取颜色
 * @param {number} latency
 * @returns {string} 颜色代码
 */
function getLatencyColor(latency) {
  if (latency < 100) return COLORS.brightGreen;
  if (latency < 200) return COLORS.green;
  if (latency < 300) return COLORS.cyan;
  if (latency < 400) return COLORS.yellow;
  if (latency < 500) return COLORS.brightYellow;
  return COLORS.brightRed;
}

/**
 * 根据错误类型获取颜色
 * @param {string} error
 * @returns {string} 颜色代码
 */
function getErrorColor(error) {
  if (error === "timeout") return COLORS.brightYellow;
  if (error.includes("ECONNREFUSED")) return COLORS.brightRed;
  if (error.includes("ECONNRESET")) return COLORS.red;
  if (error.includes("certificate")) return COLORS.magenta;
  if (error.includes("handshake")) return COLORS.yellow;
  return COLORS.red;
}

// ==================== 数据加载 ====================

/**
 * 从文件加载IP列表
 * @param {string} filePath - 文件路径
 */
function loadIpPortList(filePath) {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    ipPortList = data
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [ipPort, location] = line.split("#");
        const [ip, port] = ipPort.split(":");
        return {
          ip,
          port: parseInt(port),
          location: location?.trim() || "Unknown",
        };
      });

    info(
      `${COLORS.brightGreen}✓${COLORS.reset} 加载完成: ${COLORS.brightWhite}${ipPortList.length}${COLORS.reset} 个测试点`,
    );
  } catch (err) {
    error(`${COLORS.brightRed}✗${COLORS.reset} 读取文件失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * 获取测试结果对象
 * @param {string} ip
 * @param {number} port
 * @param {string} location
 * @returns {Object} 测试结果
 */
function getTestResult(ip, port, location) {
  const key = `${ip}:${port}`;
  if (!testResults.has(key)) {
    testResults.set(key, {
      location,
      ip,
      port,
      successes: 0,
      failures: 0,
      latencies: [],
      completed: false,
    });
  }
  return testResults.get(key);
}

// ==================== VLESS握手生成 ====================

/**
 * 生成VLESS握手数据包
 * @returns {Buffer} 握手数据
 */
function generateVLESSHandshake() {
  try {
    // 版本 + UUID(16) + 附加数据长度(0)
    const uuidBytes = Buffer.from(VLESS_CONFIG.uuid.replace(/-/g, ""), "hex");
    const version = Buffer.from([1]); // 协议版本
    const command = Buffer.from([1]); // 命令: TCP
    const port = Buffer.alloc(2); // 端口
    port.writeUInt16BE(443);

    // 地址类型: 域名(3)
    const addrType = Buffer.from([3]);
    const addr = Buffer.from(VLESS_CONFIG.host, "utf8");
    const addrLen = Buffer.from([addr.length]);
    const padding = Buffer.from([0]);

    return Buffer.concat([
      version,
      uuidBytes,
      Buffer.from([0]), // 附加数据长度
      command,
      port,
      addrType,
      addrLen,
      addr,
      padding,
    ]);
  } catch (e) {
    error(`${COLORS.brightRed}生成握手失败:${COLORS.reset} ${e.message}`);
    // 返回最小有效握手包
    return Buffer.alloc(32, 0);
  }
}

// ==================== 测试执行 ====================

/**
 * 执行单次连接测试
 * @param {Object} target - 目标 {ip, port, location}
 * @param {number} testRound - 当前测试轮次
 */
function testConnection(target, testRound) {
  const { ip, port, location } = target;
  const key = `${ip}:${port}`;
  const result = getTestResult(ip, port, location);

  activeConnections++;

  debug(
    `${COLORS.dim}开始测试 [${COLORS.cyan}${location}${COLORS.dim}] ${COLORS.white}${ip}:${port}${COLORS.dim} (${testRound}/${TEST_CONFIG.TESTS_PER_IP})${COLORS.reset}`,
    { active: activeConnections },
  );

  // 记录各个阶段的时间戳
  const timings = {
    start: Date.now(),
    tlsHandshake: 0,
    wsUpgrade: 0,
    handshakeSent: 0,
    response: 0,
  };

  let testCompleted = false;
  let upgradeCompleted = false;
  let handshakeSent = false;

  // TLS配置
  const tlsOptions = {
    rejectUnauthorized: false,
    servername: VLESS_CONFIG.sni || ip,
    host: ip,
    port: port,
    ALPNProtocols: ["http/1.1"],
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    secureOptions: constants.SSL_OP_NO_TICKET,
    ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256",
    timeout: TEST_CONFIG.CONNECTION_TIMEOUT,
  };

  if (globalECHConfig) {
    tlsOptions.ECHConfig = globalECHConfig;
    if (TEST_CONFIG.LOG_LEVEL === "debug") {
      debug(
        `${COLORS.dim}使用ECH配置${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
      );
    }
  }

  // WebSocket头
  const headers = {
    Host: VLESS_CONFIG.host || ip,
    "Sec-WebSocket-Key": generateWebSocketKey(),
    "Sec-WebSocket-Version": 13,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Sec-WebSocket-Protocol": "vless",
  };

  // 创建TLS连接
  const tlsSocket = tls.connect(port, ip, tlsOptions);

  // 记录TLS握手完成时间
  tlsSocket.once("secureConnect", () => {
    timings.tlsHandshake = Date.now() - timings.start;
    debug(
      `${COLORS.green}TLS握手完成${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
      {
        protocol: tlsSocket.getProtocol(),
        cipher: tlsSocket.getCipher().name,
        time: `${timings.tlsHandshake}ms`,
      },
    );
  });

  // 自定义WebSocket以更好地控制时间测量
  const ws = new WebSocket(`wss://${ip}:${port}${VLESS_CONFIG.path}`, {
    headers,
    createConnection: () => tlsSocket,
    handshakeTimeout: TEST_CONFIG.CONNECTION_TIMEOUT,
    rejectUnauthorized: false,
    perMessageDeflate: false,
    followRedirects: false,
    maxRedirects: 0,
  });

  // 超时处理
  const timeoutId = setTimeout(() => {
    if (!testCompleted) {
      debug(
        `${COLORS.brightYellow}连接超时${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
        { time: `${TEST_CONFIG.CONNECTION_TIMEOUT}ms` },
      );
      completeTest(false, "timeout");
    }
  }, TEST_CONFIG.CONNECTION_TIMEOUT);

  /**
   * 完成测试并清理
   * @param {boolean} success - 是否成功
   * @param {string|number} details - 延迟或错误信息
   */
  const completeTest = (success, details) => {
    if (testCompleted) return;
    testCompleted = true;

    clearTimeout(timeoutId);
    safeClose(ws);

    if (success) {
      result.successes++;

      // 使用VLESS协议握手时间（从发送握手到收到响应）
      // 如果无法精确计算，使用总时间减去TLS握手时间
      let vlessHandshakeTime;

      if (timings.handshakeSent > 0 && timings.response > 0) {
        // 精确计算：从发送握手到收到响应
        vlessHandshakeTime = timings.response - timings.handshakeSent;
      } else {
        // 估算：总时间减去TLS握手时间和预估的WebSocket升级时间
        // WebSocket升级通常需要1个RTT
        const estimatedWsUpgradeTime = timings.tlsHandshake; // 估算为1个RTT
        vlessHandshakeTime = Math.max(
          1,
          Date.now() -
            timings.start -
            timings.tlsHandshake -
            estimatedWsUpgradeTime,
        );
      }

      // 确保延迟在合理范围内
      vlessHandshakeTime = Math.max(1, Math.min(5000, vlessHandshakeTime));
      result.latencies.push(vlessHandshakeTime);

      // 根据延迟选择颜色
      const latencyColor = getLatencyColor(vlessHandshakeTime);
      const roundStr = `${COLORS.dim}[${testRound}/${TEST_CONFIG.TESTS_PER_IP}]${COLORS.reset}`;

      // 显示详细的时间分解（调试模式）
      if (TEST_CONFIG.LOG_LEVEL === "debug") {
        info(
          `${COLORS.brightGreen}✓${COLORS.reset} ` +
            `${COLORS.brightCyan}${location}${COLORS.reset} ` +
            `${COLORS.brightWhite}${ip}:${port}${COLORS.reset} ` +
            `${roundStr} ` +
            `${latencyColor}${vlessHandshakeTime}ms${COLORS.reset} ` +
            `${COLORS.dim}(TLS:${timings.tlsHandshake}ms)${COLORS.reset}`,
        );
      } else {
        info(
          `${COLORS.brightGreen}✓${COLORS.reset} ` +
            `${COLORS.brightCyan}${location}${COLORS.reset} ` +
            `${COLORS.brightWhite}${ip}:${port}${COLORS.reset} ` +
            `${roundStr} ` +
            `${latencyColor}${vlessHandshakeTime}ms${COLORS.reset}`,
        );
      }
    } else {
      result.failures++;

      // 根据错误类型选择颜色
      const errorColor = getErrorColor(details);
      const roundStr = `${COLORS.dim}[${testRound}/${TEST_CONFIG.TESTS_PER_IP}]${COLORS.reset}`;

      debug(
        `${COLORS.brightRed}✗${COLORS.reset} ` +
          `${COLORS.brightCyan}${location}${COLORS.reset} ` +
          `${COLORS.brightWhite}${ip}:${port}${COLORS.reset} ` +
          `${roundStr} ` +
          `${errorColor}${details}${COLORS.reset}`,
      );
    }

    activeConnections--;
    completedTests++;

    // 检查是否完成该IP的所有测试
    if (result.successes + result.failures === TEST_CONFIG.TESTS_PER_IP) {
      result.completed = true;
      const avgLatency = calculateAverage(result.latencies);

      // 根据成功率选择颜色
      let statusColor = COLORS.green;
      if (result.successes === 0) statusColor = COLORS.red;
      else if (result.successes < TEST_CONFIG.TESTS_PER_IP)
        statusColor = COLORS.yellow;

      info(
        `${COLORS.bright}${statusColor}═══════════════════════════════════════${COLORS.reset}`,
      );
      info(
        `${COLORS.bright}${statusColor} 完成测试 [${location}]${COLORS.reset} ` +
          `${COLORS.brightGreen}✓${result.successes}${COLORS.reset} ` +
          `${COLORS.brightRed}✗${result.failures}${COLORS.reset} ` +
          `${COLORS.dim}平均:${COLORS.reset} ${avgLatency ? getLatencyColor(avgLatency) + avgLatency + "ms" + COLORS.reset : COLORS.dim + "N/A" + COLORS.reset}`,
      );
      info(
        `${COLORS.bright}${statusColor}═══════════════════════════════════════${COLORS.reset}`,
      );
    } else {
      // 安排下一次测试
      setTimeout(() => {
        testConnection(target, testRound + 1);
      }, TEST_CONFIG.RETRY_DELAY);
    }

    // 启动下一个IP的测试
    startNextTest();

    // 检查是否全部完成
    if (completedTests === ipPortList.length * TEST_CONFIG.TESTS_PER_IP) {
      info(
        `${COLORS.bright}${COLORS.green}🎉 所有测试完成，保存结果...${COLORS.reset}`,
      );
      saveResults();
      process.exit(0);
    }
  };

  // WebSocket事件监听
  ws.on("upgrade", (response) => {
    upgradeCompleted = true;
    timings.wsUpgrade = Date.now() - timings.start;
    debug(
      `${COLORS.green}WebSocket升级成功${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
      {
        status: response.statusCode,
        time: `${timings.wsUpgrade}ms`,
      },
    );
  });

  ws.on("open", () => {
    timings.handshakeSent = Date.now() - timings.start;
    debug(
      `${COLORS.green}连接建立，发送VLESS握手${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
      {
        time: `${timings.handshakeSent}ms`,
      },
    );

    handshakeSent = true;

    // 发送VLESS握手包
    const handshake = generateVLESSHandshake();
    ws.send(handshake);

    // 设置一个更短的超时来等待VLESS响应
    // 如果5秒内没有收到响应，认为握手失败
    setTimeout(() => {
      if (!testCompleted && handshakeSent && timings.response === 0) {
        completeTest(false, "vless_timeout");
      }
    }, 3000);
  });

  ws.on("message", (data) => {
    // 记录收到响应的时间
    timings.response = Date.now() - timings.start;

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // 检查VLESS响应: 第二个字节应为0表示成功
    if (chunk.length >= 2 && chunk[1] === 0) {
      completeTest(true, timings.response - timings.handshakeSent);
    } else {
      // 收到非成功响应
      debug(
        `${COLORS.yellow}收到非成功响应${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
        {
          responseBytes: chunk.slice(0, 4).toString("hex"),
        },
      );
      completeTest(false, "invalid_response");
    }
  });

  ws.on("close", (code, reason) => {
    if (!testCompleted) {
      debug(
        `${COLORS.yellow}连接关闭${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
        {
          code,
          reason: reason?.toString(),
        },
      );
      completeTest(false, `close_${code}`);
    }
  });

  ws.on("error", (err) => {
    if (!testCompleted) {
      debug(
        `${COLORS.red}连接错误${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
        {
          error: err.message,
        },
      );
      completeTest(false, err.message);
    }
  });

  ws.on("unexpected-response", (request, response) => {
    let body = "";
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      debug(
        `${COLORS.yellow}意外响应${COLORS.reset} [${COLORS.cyan}${location}${COLORS.reset}]`,
        {
          status: response.statusCode,
          body: body.substring(0, 100),
        },
      );
      completeTest(false, `HTTP_${response.statusCode}`);
    });
  });
}
/**
 * 安全关闭WebSocket
 * @param {WebSocket} ws
 */
function safeClose(ws) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "normal");
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  } catch (e) {
    // 忽略关闭错误
  }
}

/**
 * 启动下一个待测试IP
 */
function startNextTest() {
  while (
    activeConnections < TEST_CONFIG.MAX_CONCURRENT &&
    nextTestIndex < ipPortList.length
  ) {
    const target = ipPortList[nextTestIndex];
    const result = getTestResult(target.ip, target.port, target.location);

    if (result.successes + result.failures === 0) {
      testConnection(target, 1);
    }
    nextTestIndex++;
  }
}

// ==================== 结果保存 ====================

/**
 * 保存测试结果到文件
 */
function saveResults() {
  const results = Array.from(testResults.values());

  // 完全成功的IP
  const passedIPs = results
    .filter((r) => r.successes === TEST_CONFIG.TESTS_PER_IP)
    .map((r) => ({
      ...r,
      avgLatency: calculateAverage(r.latencies),
    }))
    .sort((a, b) => a.avgLatency - b.avgLatency);

  // 按国家分组
  const countryGroups = {};
  passedIPs.forEach((item) => {
    const country = item.location.replace(/\d+$/, "").trim();
    if (!countryGroups[country]) countryGroups[country] = [];
    countryGroups[country].push(item);
  });

  // 只保存IP数量>=5的国家
  const validCountries = Object.entries(countryGroups)
    .filter(([_, items]) => items.length >= 5)
    .sort((a, b) => a[1][0].avgLatency - b[1][0].avgLatency);

  // 生成top5和all数据
  const top5Data = [];
  const allData = [];

  validCountries.forEach(([country, items]) => {
    items.slice(0, 5).forEach((item, idx) => {
      top5Data.push(`${item.ip}:${item.port}#${country}${idx + 1}`);
    });
    items.forEach((item, idx) => {
      allData.push(`${item.ip}:${item.port}#${country}${idx + 1}`);
    });
  });

  if (top5Data.length > 0) {
    fs.writeFileSync("vless_top5.txt", top5Data.join("\n"), "utf8");
    fs.writeFileSync("vless_all.txt", allData.join("\n"), "utf8");
    info(
      `${COLORS.green}已保存 ${COLORS.brightWhite}${top5Data.length}${COLORS.reset}${COLORS.green} 条记录到 vless_top5.txt${COLORS.reset}`,
    );
    info(
      `${COLORS.green}已保存 ${COLORS.brightWhite}${allData.length}${COLORS.reset}${COLORS.green} 条记录到 vless_all.txt${COLORS.reset}`,
    );
  }

  // 生成详细结果
  const detailedData = [];
  const failedData = [];

  validCountries.forEach(([country, items]) => {
    items.forEach((item, idx) => {
      detailedData.push(
        `${item.ip}:${item.port}#${country}${idx + 1} - ` +
          `${item.avgLatency}ms [${item.latencies.join(", ")}]`,
      );
    });
  });

  // 失败记录
  results
    .filter((r) => r.successes < TEST_CONFIG.TESTS_PER_IP)
    .sort((a, b) => b.successes - a.successes)
    .forEach((r) => {
      const avg =
        r.latencies.length > 0 ? calculateAverage(r.latencies) : "N/A";
      failedData.push(
        `${r.ip}:${r.port}#${r.location} - ` +
          `成功: ${r.successes}/${TEST_CONFIG.TESTS_PER_IP} 平均: ${avg}ms [${r.latencies.join(", ")}]`,
      );
    });

  fs.writeFileSync(
    "vless_passed_detailed.txt",
    detailedData.join("\n"),
    "utf8",
  );
  fs.writeFileSync("vless_failed.txt", failedData.join("\n"), "utf8");

  info(
    `${COLORS.green}已保存 ${COLORS.brightWhite}${detailedData.length}${COLORS.reset}${COLORS.green} 条详细记录到 vless_passed_detailed.txt${COLORS.reset}`,
  );
  info(
    `${COLORS.green}已保存 ${COLORS.brightWhite}${failedData.length}${COLORS.reset}${COLORS.green} 条失败记录到 vless_failed.txt${COLORS.reset}`,
  );

  // 统计信息
  const totalPassed = passedIPs.length;
  const totalFailed = results.length - totalPassed;
  const successRate = ((totalPassed / results.length) * 100).toFixed(2);

  info(
    `${COLORS.bright}${COLORS.green}═══════════════════════════════════════${COLORS.reset}`,
  );
  info(`${COLORS.bright}${COLORS.green} 测试完成统计${COLORS.reset}`);
  info(
    `${COLORS.bright}${COLORS.green}═══════════════════════════════════════${COLORS.reset}`,
  );
  info(
    `${COLORS.white}总测试IP数: ${COLORS.brightWhite}${results.length}${COLORS.reset}`,
  );
  info(
    `${COLORS.green}完全通过IP: ${COLORS.brightGreen}${totalPassed}${COLORS.reset} ${COLORS.dim}(${successRate}%)${COLORS.reset}`,
  );
  info(
    `${COLORS.red}部分失败IP: ${COLORS.brightRed}${totalFailed}${COLORS.reset}`,
  );

  if (validCountries.length > 0) {
    info(`${COLORS.brightCyan}各国通过IP数量(>=5):${COLORS.reset}`);
    validCountries.forEach(([country, items]) => {
      const avgCountryLatency = calculateAverage(
        items.map((i) => i.avgLatency),
      );
      info(
        `  ${COLORS.cyan}${country}:${COLORS.reset} ` +
          `${COLORS.brightWhite}${items.length}${COLORS.reset}个IP ` +
          `${COLORS.dim}(平均:${COLORS.reset}${getLatencyColor(avgCountryLatency)}${avgCountryLatency}ms${COLORS.reset}${COLORS.dim})${COLORS.reset}`,
      );
    });
  }
}

// ==================== 程序入口 ====================

/**
 * 主函数
 */
/**
 * 主函数
 */
async function main() {
  console.log(
    `\n${COLORS.bright}${COLORS.cyan}🚀 VLESS 代理测试工具 v3.0.0${COLORS.reset}\n`,
  );

  info(
    `${COLORS.white}配置: ${COLORS.brightYellow}并发=${TEST_CONFIG.MAX_CONCURRENT}${COLORS.reset}, ${COLORS.brightYellow}每IP测试=${TEST_CONFIG.TESTS_PER_IP}${COLORS.reset}次`,
  );

  // 加载IP列表
  loadIpPortList("ip_all.txt");

  if (ipPortList.length === 0) {
    error(`${COLORS.brightRed}没有可测试的IP${COLORS.reset}`);
    process.exit(1);
  }

  // 获取全局ECH配置
  info(`${COLORS.white}正在获取ECH配置...${COLORS.reset}`);
  try {
    globalECHConfig = await getECHConfig(VLESS_CONFIG.sni);
    if (globalECHConfig) {
      info(
        `${COLORS.green}✓ ECH配置获取成功${COLORS.reset} (${globalECHConfig.toString("base64")})`,
      );
    } else {
      info(
        `${COLORS.yellow}⚠ 未获取到ECH配置，将继续使用普通TLS连接${COLORS.reset}`,
      );
    }
  } catch (e) {
    info(
      `${COLORS.yellow}⚠ ECH配置获取失败: ${e.message}，将继续使用普通TLS连接${COLORS.reset}`,
    );
  }

  info(
    `${COLORS.green}开始测试 ${COLORS.brightWhite}${ipPortList.length}${COLORS.reset}${COLORS.green} 个目标...${COLORS.reset}`,
  );

  // 开始测试
  startNextTest();
}

// 启动
main();
