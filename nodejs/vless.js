/**
 * VLESS 代理服务器延迟测试工具
 * 
 * 本工具用于测试多个IP地址的VLESS代理服务器的连通性和延迟。
 * 主要功能：
 * 1. 从文件读取IP地址和端口列表
 * 2. 对每个IP进行多次WebSocket连接测试
 * 3. 发送VLESS协议握手请求验证服务器响应
 * 4. 记录测试结果并生成报告文件
 * 
 * @author AI Assistant
 * @version 2.0.0
 * @license MIT
 */

// ==================== 模块导入 ====================
import fs from "fs";          // 文件系统操作模块
import WebSocket from "ws";   // WebSocket客户端模块
import tls from "tls";        // TLS/SSL加密模块

// ==================== 常量定义 ====================

/** 
 * VLESS协议配置
 * @constant {Object}
 * @property {string} uuid - VLESS协议的UUID标识符
 * @property {string} sni - TLS握手时的SNI（Server Name Indication）主机名
 * @property {string} host - WebSocket连接的Host头
 * @property {string} path - WebSocket连接的路径
 */
const VLESS_CONFIG = {
  uuid: "00000000-0000-4000-8000-000000000000",
  sni: "sub.mot.ip-ddns.com",
  host: "sub.mot.ip-ddns.com",
  path: "/@Marisa_kristi",
};

/** 
 * 测试配置常量
 * @constant {number} MAX_CONCURRENT - 最大并发连接数，限制同时进行的测试数量
 * @constant {number} TESTS_PER_IP - 每个IP地址的测试次数，用于统计成功率
 * @constant {number} CONNECTION_TIMEOUT - 连接超时时间（毫秒）
 * @constant {number} RETRY_DELAY - 测试失败后的重试延迟（毫秒）
 */
const MAX_CONCURRENT = 50;
const TESTS_PER_IP = 4;
const CONNECTION_TIMEOUT = 15000;
const RETRY_DELAY = 500;

// ==================== 状态变量 ====================

/** 
 * IP地址和端口列表
 * 存储从文件读取的所有测试点
 * @type {Array<{ip: string, port: number, location: string}>}
 */
let ipPortList = [];

/** 
 * 测试结果存储对象
 * 键格式: "ip:port"
 * @type {Object.<string, {
 *   location: string,
 *   ip: string,
 *   port: number,
 *   successes: number,
 *   failures: number,
 *   latencies: number[],
 *   completed: boolean
 * }>}
 */
let testResults = {};

/** 
 * 已完成测试计数器
 * 用于判断所有测试是否完成
 * @type {number}
 */
let completedTests = 0;

/** 
 * 当前活跃连接数
 * 用于控制并发数量
 * @type {number}
 */
let activeConnections = 0;

/** 
 * 下一个要测试的IP索引
 * 用于遍历ipPortList进行测试
 * @type {number}
 */
let nextTestIndex = 0;

// ==================== 工具函数 ====================

/**
 * 将UUID字符串转换为字节数组
 * 
 * 严格按照 _worker.js 的格式进行转换：
 * 1. 移除UUID中的连字符
 * 2. 每两个十六进制字符转换为一个字节
 * 
 * @param {string} uuid - 标准UUID格式字符串（如 "00000000-0000-4000-8000-000000000000"）
 * @returns {Uint8Array} 16字节的UUID字节数组
 */
function uuidToBytes(uuid) {
  // 移除UUID中的连字符
  const uuidStr = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  
  // 每两个字符（一个字节）进行转换
  for (let i = 0; i < 32; i += 2) {
    bytes[i / 2] = parseInt(uuidStr.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 将字节数组格式化为UUID字符串
 * 
 * 匹配 _worker.js 的 formatIdentifier 函数格式：
 * 将16字节数据转换为标准的8-4-4-4-12格式的UUID
 * 
 * @param {Uint8Array} bytes - 16字节的UUID字节数组
 * @returns {string} 标准格式的UUID字符串
 */
function formatUUID(bytes) {
  // 将每个字节转换为两位十六进制数
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  
  // 格式化为标准UUID格式：8-4-4-4-12
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}

/**
 * 生成VLESS协议握手请求数据包
 * 
 * VLESS协议握手包格式（严格按照协议规范）：
 * - 第0字节：协议版本（0）
 * - 第1-16字节：UUID（16字节）
 * - 第17字节：附加数据长度（0）
 * - 第18-19字节：目标端口（2字节，大端序）
 * - 第20字节：地址类型（1表示IPv4）
 * - 第21-24字节：IPv4地址（4字节，这里使用1.1.1.1）
 * 
 * @returns {Uint8Array} 完整的VLESS握手请求数据包
 */
function generateVLESSHandshake() {
  // 版本: 0 (1字节)
  const version = new Uint8Array([0]);

  // UUID (16字节) - _worker.js 从第1字节开始取16字节
  const uuidBytes = uuidToBytes(VLESS_CONFIG.uuid);

  // 附加数据长度: 0 (1字节)
  const addonsLen = new Uint8Array([0]);

  // 目标端口 (2字节) - 使用常见的80端口
  const portBytes = new Uint8Array(2);
  const portView = new DataView(portBytes.buffer);
  portView.setUint16(0, 80); // 使用80端口

  // 地址类型: 1 (IPv4) - 使用IPv4地址更简单
  const addrType = new Uint8Array([1]);

  // IPv4地址: 使用常见的IP (1.1.1.1)
  const ipBytes = new Uint8Array([1, 1, 1, 1]);

  // 计算总长度
  const totalLength = 1 + 16 + 1 + 2 + 1 + 4;
  const request = new Uint8Array(totalLength);

  let offset = 0;
  request.set(version, offset);
  offset += 1;
  request.set(uuidBytes, offset);
  offset += 16;
  request.set(addonsLen, offset);
  offset += 1;
  request.set(portBytes, offset);
  offset += 2;
  request.set(addrType, offset);
  offset += 1;
  request.set(ipBytes, offset); // IPv4地址直接4字节

  return request;
}

/**
 * 计算延迟平均值
 * 
 * @param {number[]} latencies - 延迟时间数组（毫秒）
 * @returns {number} 平均延迟，如果没有数据则返回0
 */
function calculateAverage(latencies) {
  if (latencies.length === 0) return 0;
  const sum = latencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencies.length);
}

// ==================== 数据管理函数 ====================

/**
 * 从文件加载IP地址和端口列表
 * 
 * 文件格式要求：
 * - 每行一个IP地址和端口，格式为 "ip:port#地点"
 * - 使用#号分隔IP:port和地点信息
 * - 空行将被忽略
 * 
 * @param {string} filePath - IP列表文件路径
 * @returns {void}
 */
function loadIpPortList(filePath) {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const lines = data.split("\n");
    
    lines.forEach((line) => {
      if (line.trim()) {
        const [ipPort, location] = line.split("#");
        const [ip, port] = ipPort.split(":");
        ipPortList.push({
          ip,
          port: parseInt(port),
          location: location?.trim() || "Unknown",
        });
      }
    });
  } catch (err) {
    console.error("读取文件失败:", err);
  }
}

/**
 * 获取或创建测试结果对象
 * 
 * 如果指定IP和端口的测试结果不存在，则创建新的结果对象。
 * 结果对象包含该测试点的所有测试数据。
 * 
 * @param {string} ip - IP地址
 * @param {number} port - 端口号
 * @param {string} location - 地理位置
 * @returns {Object} 测试结果对象
 */
function getTestResult(ip, port, location) {
  const key = `${ip}:${port}`;
  if (!testResults[key]) {
    testResults[key] = {
      location,
      ip,
      port,
      successes: 0,      // 成功次数
      failures: 0,       // 失败次数
      latencies: [],     // 延迟记录
      completed: false,  // 是否完成所有测试
    };
  }
  return testResults[key];
}

// ==================== 测试执行函数 ====================

/**
 * 创建并执行WebSocket连接测试
 * 
 * 为指定IP和端口创建WebSocket连接，发送VLESS握手请求，
 * 并根据响应判断测试结果。
 * 
 * @param {string} ip - 目标IP地址
 * @param {number} port - 目标端口
 * @param {string} location - 地理位置
 * @param {number} testRound - 当前测试轮次（1-TESTS_PER_IP）
 * @returns {void}
 */
function createWebSocketConnection(ip, port, location, testRound) {
  activeConnections++;

  // 构建WebSocket URL
  const wsUrl = `wss://${ip}:${port}${VLESS_CONFIG.path}`;

  // TLS连接选项
  const tlsOptions = {
    rejectUnauthorized: false,  // 忽略证书验证
    servername: VLESS_CONFIG.sni, // SNI主机名
    host: ip,
    port: port,
  };

  // WebSocket握手头
  const headers = {
    Host: VLESS_CONFIG.host,
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": 13,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  const result = getTestResult(ip, port, location);

  console.log(
    `🔄 测试 ${location} (${ip}:${port}) 第${testRound}/${TESTS_PER_IP}次 [活跃: ${activeConnections}, 已完成: ${completedTests}]`,
  );

  // 创建WebSocket连接
  const ws = new WebSocket(wsUrl, {
    headers: headers,
    createConnection: () => tls.connect(tlsOptions),
    handshakeTimeout: 8000,
    followRedirects: false,
    perMessageDeflate: false,
  });

  let handshakeTime;
  let timeoutId;
  let testCompleted = false;

  // 设置超时定时器
  timeoutId = setTimeout(() => {
    if (!testCompleted) {
      console.log(`⏰ 超时 ${location} (${ip}:${port}) 第${testRound}次`);
      ws.terminate();
      handleTestCompletion(ip, port, location, false, testRound, "timeout");
    }
  }, CONNECTION_TIMEOUT);

  // WebSocket连接成功事件
  ws.on("open", () => {
    console.log(
      `✅ WebSocket连接成功 ${location} (${ip}:${port}) 第${testRound}次`,
    );
    handshakeTime = Date.now();

    // 发送VLESS握手请求
    const vlessHandshake = generateVLESSHandshake();
    ws.send(vlessHandshake);
  });

  // WebSocket升级成功事件
  ws.on("upgrade", (response) => {
    console.log(`📡 WebSocket升级成功，状态码: ${response.statusCode}`);
  });

  // 收到消息事件
  ws.on("message", (data) => {
    if (testCompleted) return;

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // 检查是否是服务端的握手响应 (version + 0)
    if (chunk.length >= 2 && chunk[1] === 0) {
      const handshakeTime_ms = Date.now() - handshakeTime;
      console.log(
        `🎉 VLESS握手成功 ${location} 第${testRound}次! 耗时: ${handshakeTime_ms}ms`,
      );

      if (!testCompleted) {
        testCompleted = true;
        clearTimeout(timeoutId);
        ws.close();
        handleTestCompletion(
          ip,
          port,
          location,
          true,
          testRound,
          handshakeTime_ms,
        );
      }
    } else {
      console.log(`⚠️ 收到非握手响应: 期望chunk[1]=0, 实际=${chunk[1]}`);
    }
  });

  // 连接关闭事件
  ws.on("close", (code, reason) => {
    clearTimeout(timeoutId);
    if (!testCompleted) {
      const reasonStr = reason ? reason.toString() : `code=${code}`;
      console.log(`🔌 连接关闭: ${reasonStr}`);
      handleTestCompletion(ip, port, location, false, testRound, reasonStr);
    }
  });

  // 错误事件
  ws.on("error", (error) => {
    console.log(
      `❌ 错误 ${location} (${ip}:${port}) 第${testRound}次: ${error.message}`,
    );
    clearTimeout(timeoutId);
    if (!testCompleted) {
      testCompleted = true;
      handleTestCompletion(ip, port, location, false, testRound, error.message);
    }
  });

  // 意外响应事件（非WebSocket响应）
  ws.on("unexpected-response", (request, response) => {
    console.log(`⚠️ 意外响应: HTTP ${response.statusCode}`);
    let body = "";
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      clearTimeout(timeoutId);
      if (!testCompleted) {
        testCompleted = true;
        handleTestCompletion(
          ip,
          port,
          location,
          false,
          testRound,
          `HTTP ${response.statusCode}`,
        );
      }
    });
  });
}

/**
 * 处理单次测试完成
 * 
 * 更新测试结果统计，并根据测试进度决定是否进行下一次测试。
 * 当所有测试完成时，触发结果保存和程序退出。
 * 
 * @param {string} ip - IP地址
 * @param {number} port - 端口号
 * @param {string} location - 地理位置
 * @param {boolean} success - 本次测试是否成功
 * @param {number} testRound - 测试轮次
 * @param {number|string} details - 成功时的延迟或失败时的错误信息
 * @returns {void}
 */
function handleTestCompletion(ip, port, location, success, testRound, details) {
  const result = getTestResult(ip, port, location);

  if (success) {
    result.successes++;
    if (typeof details === "number") {
      result.latencies.push(details);
    }
    console.log(
      `✅ 第${testRound}次测试成功 (${result.successes}/${TESTS_PER_IP}) - 延迟: ${details}ms`,
    );
  } else {
    result.failures++;
    console.log(
      `❌ 第${testRound}次测试失败 (${result.failures}/${TESTS_PER_IP}) - ${details}`,
    );
  }

  activeConnections--;
  completedTests++;

  if (result.successes + result.failures === TESTS_PER_IP) {
    result.completed = true;
  }

  // 如果测试次数不足，延迟后开始下一次测试
  if (result.successes + result.failures < TESTS_PER_IP) {
    const nextRound = result.successes + result.failures + 1;
    setTimeout(() => {
      createWebSocketConnection(ip, port, location, nextRound);
    }, RETRY_DELAY);
  }

  startNextTest();

  // 所有测试完成，保存结果并退出
  if (completedTests === ipPortList.length * TESTS_PER_IP) {
    console.log("\n🎉 所有测试完成");
    saveResults();
    process.exit(0);
  }
}

/**
 * 启动下一个待测试的IP
 * 
 * 在并发限制内，从待测试列表中取出下一个IP开始测试。
 * 如果某个IP还未开始测试（成功+失败次数为0），则启动第一次测试。
 * 
 * @returns {void}
 */
function startNextTest() {
  while (
    activeConnections < MAX_CONCURRENT &&
    nextTestIndex < ipPortList.length
  ) {
    const nextIpPort = ipPortList[nextTestIndex];
    const result = getTestResult(
      nextIpPort.ip,
      nextIpPort.port,
      nextIpPort.location,
    );

    if (result.successes + result.failures === 0) {
      createWebSocketConnection(
        nextIpPort.ip,
        nextIpPort.port,
        nextIpPort.location,
        1,
      );
    }
    nextTestIndex++;
  }
}

/**
 * 开始并发测试
 * 
 * 初始化测试环境并开始执行并发测试。
 * 打印测试配置信息。
 * 
 * @returns {void}
 */
function startConcurrentTests() {
  console.log(
    `🚀 开始并发测试，每个IP测试${TESTS_PER_IP}次，最大并发数: ${MAX_CONCURRENT}`,
  );
  startNextTest();
}

// ==================== 结果保存函数 ====================

/**
 * 保存测试结果到文件
 * 
 * 生成以下文件：
 * - vless_top5.txt: 每个国家延迟最低的5个IP
 * - vless_all.txt: 所有通过测试的IP（按国家分组排序）
 * - vless_passed_detailed.txt: 详细通过结果（包含每次测试的延迟）
 * - vless_failed.txt: 所有失败的IP
 * 
 * @returns {void}
 */
function saveResults() {
  const top5Data = [];
  const allData = [];
  const countryOrder = {};
  const countryCounters = {};
  const top5Counters = {};

  // 收集所有通过测试的IP（成功次数等于总测试次数）
  const passedIPs = [];

  Object.values(testResults).forEach((result) => {
    if (result.successes === TESTS_PER_IP) {
      passedIPs.push({
        ...result,
        avgLatency: calculateAverage(result.latencies),
      });
    }
  });

  // 按延迟排序
  passedIPs.sort((a, b) => a.avgLatency - b.avgLatency);

  // 按国家分组
  const countryGroups = {};
  passedIPs.forEach((item) => {
    const countryBase = item.location.replace(/\d+$/, "").trim();
    if (!countryGroups[countryBase]) {
      countryGroups[countryBase] = [];
      if (!countryOrder[countryBase]) {
        countryOrder[countryBase] = Object.keys(countryOrder).length;
      }
    }
    countryGroups[countryBase].push(item);
  });

  // 按原始出现顺序排序国家
  const sortedCountries = Object.keys(countryGroups).sort((a, b) => {
    return (countryOrder[a] || 0) - (countryOrder[b] || 0);
  });

  // 初始化计数器
  sortedCountries.forEach((country) => {
    countryCounters[country] = 1;
    top5Counters[country] = 1;
  });

  // 生成所有IP列表
  sortedCountries.forEach((country) => {
    const countryItems = countryGroups[country];

    countryItems.forEach((item) => {
      allData.push(
        `${item.ip}:${item.port}#${country}${countryCounters[country]} - ` +
          `${item.avgLatency}ms`,
      );
      countryCounters[country]++;
    });

    // 生成每个国家前5名列表
    countryItems.forEach((item, index) => {
      if (index < 5) {
        top5Data.push(
          `${item.ip}:${item.port}#${country}${top5Counters[country]} - ` +
            `${item.avgLatency}ms`,
        );
        top5Counters[country]++;
      }
    });
  });

  // 写入文件
  fs.writeFileSync("vless_top5.txt", top5Data.join("\n"), "utf8");
  fs.writeFileSync("vless_all.txt", allData.join("\n"), "utf8");
  
  // 保存详细结果
  saveDetailedResults(countryOrder);
}

/**
 * 保存详细测试结果
 * 
 * 生成包含详细延迟信息的通过IP列表和所有失败IP列表。
 * 
 * @param {Object} countryOrder - 国家出现顺序映射
 * @returns {void}
 */
function saveDetailedResults(countryOrder) {
  const detailedData = [];
  const failedData = [];

  // 收集通过测试的IP
  const passedIPs = [];
  Object.values(testResults).forEach((result) => {
    if (result.successes === TESTS_PER_IP) {
      passedIPs.push({
        ...result,
        avgLatency: calculateAverage(result.latencies),
      });
    }
  });

  passedIPs.sort((a, b) => a.avgLatency - b.avgLatency);

  // 按国家分组
  const countryGroups = {};
  passedIPs.forEach((item) => {
    const countryBase = item.location.replace(/\d+$/, "").trim();
    if (!countryGroups[countryBase]) {
      countryGroups[countryBase] = [];
    }
    countryGroups[countryBase].push(item);
  });

  // 按原始顺序排序国家
  const sortedCountries = Object.keys(countryGroups).sort((a, b) => {
    return (countryOrder[a] || 0) - (countryOrder[b] || 0);
  });

  // 初始化计数器
  const tempCounters = {};
  sortedCountries.forEach((country) => {
    tempCounters[country] = 1;
  });

  // 生成详细通过数据
  sortedCountries.forEach((country) => {
    const countryItems = countryGroups[country];
    countryItems.forEach((item) => {
      const latenciesStr = item.latencies.join(", ");
      detailedData.push(
        `${item.ip}:${item.port}#${country}${tempCounters[country]} - ` +
          `${item.avgLatency}ms [${latenciesStr}]`,
      );
      tempCounters[country]++;
    });
  });

  // 收集失败IP
  Object.values(testResults).forEach((result) => {
    if (result.successes < TESTS_PER_IP) {
      failedData.push(`${result.ip}:${result.port}#${result.location}`);
    }
  });

  // 写入文件
  fs.writeFileSync(
    "vless_passed_detailed.txt",
    detailedData.join("\n"),
    "utf8",
  );
  fs.writeFileSync("vless_failed.txt", failedData.join("\n"), "utf8");

  console.log(`✅ 已保存详细通过结果到 vless_passed_detailed.txt`);
  console.log(`✅ 已保存失败结果到 vless_failed.txt`);
}

// ==================== 主函数 ====================

/**
 * 程序主入口函数
 * 
 * 执行流程：
 * 1. 加载IP列表文件
 * 2. 检查是否有可测试的IP
 * 3. 启动并发测试
 * 
 * @returns {void}
 */
function main() {
  console.log("🚀 开始加载 IP 列表...");
  loadIpPortList("ip_all.txt");

  console.log(`📋 共加载 ${ipPortList.length} 个测试点`);

  if (ipPortList.length > 0) {
    console.log("");
    startConcurrentTests();
  } else {
    console.log("❌ 没有找到可测试的 IP");
  }
}

// 启动程序
main();