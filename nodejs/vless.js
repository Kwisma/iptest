import fs from "fs";
import WebSocket from "ws";
import tls from "tls";

// IP 和端口列表（包含备注）
let ipPortList = [];

// 从文件读取 ipPortList
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

let testResults = {};
let completedTests = 0;
let activeConnections = 0;
let nextTestIndex = 0;
const MAX_CONCURRENT = 50;
const TESTS_PER_IP = 4;

// 完全按照提供的 VLESS 链接参数配置
const vlessConfig = {
  uuid: "00000000-0000-4000-8000-000000000000",
  server: "127.0.0.1",
  port: 443,
  security: "tls",
  sni: "6i2v3.ymj.xx.kg",
  type: "ws",
  host: "6i2v3.ymj.xx.kg",
  path: "/@Marisa_kristi",
  encryption: "none",
  fp: "chrome",
  name: "测试",
};

// 将UUID字符串转换为字节数组（严格按照 _worker.js 的格式）
function uuidToBytes(uuid) {
  const uuidStr = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 32; i += 2) {
    bytes[i / 2] = parseInt(uuidStr.substring(i, i + 2), 16);
  }
  return bytes;
}

// 格式化UUID为字符串（匹配 _worker.js 的 formatIdentifier 函数）
function formatUUID(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}

// 生成VLESS协议请求数据包（完全匹配 _worker.js 的解析逻辑）
function generateVLESSHandshake() {
  // 版本: 0 (1字节)
  const version = new Uint8Array([0]);

  // UUID (16字节) - _worker.js 从第1字节开始取16字节
  const uuidBytes = uuidToBytes(vlessConfig.uuid);

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

  // 验证UUID格式
  const uuidForValidation = formatUUID(request.slice(1, 17));
  //console.log(`   发送的UUID: ${uuidForValidation}`);
  //console.log(`   期望的UUID: ${vlessConfig.uuid}`);

  return request;
}

function getTestResult(ip, port, location) {
  const key = `${ip}:${port}`;
  if (!testResults[key]) {
    testResults[key] = {
      location,
      ip,
      port,
      successes: 0,
      failures: 0,
      latencies: [],
      completed: false,
    };
  }
  return testResults[key];
}

function createWebSocketConnection(ip, port, location, testRound) {
  activeConnections++;

  const wsUrl = `wss://${ip}:${port}${vlessConfig.path}`;

  const tlsOptions = {
    rejectUnauthorized: false,
    servername: vlessConfig.sni,
    host: ip,
    port: port,
  };

  const headers = {
    Host: vlessConfig.host,
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

  timeoutId = setTimeout(() => {
    if (!testCompleted) {
      console.log(`⏰ 超时 ${location} (${ip}:${port}) 第${testRound}次`);
      ws.terminate();
      handleTestCompletion(ip, port, location, false, testRound, "timeout");
    }
  }, 15000);

  ws.on("open", () => {
    console.log(
      `✅ WebSocket连接成功 ${location} (${ip}:${port}) 第${testRound}次`,
    );
    handshakeTime = Date.now();

    // 发送VLESS握手请求
    const vlessHandshake = generateVLESSHandshake();
    ws.send(vlessHandshake);
    //console.log(`📤 已发送VLESS握手请求 (${vlessHandshake.length} 字节)`);
    //console.log(`   请求数据: ${Buffer.from(vlessHandshake).toString('hex')}`);
  });

  ws.on("upgrade", (response) => {
    console.log(`📡 WebSocket升级成功，状态码: ${response.statusCode}`);
    //console.log(`   响应头: ${JSON.stringify(response.headers)}`);
  });

  ws.on("message", (data) => {
    if (testCompleted) return;

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

    //console.log(`📥 收到数据: ${chunk.length} 字节`);
    //console.log(`   数据前8字节: ${chunk.slice(0, 8).toString('hex')}`);

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

  ws.on("close", (code, reason) => {
    clearTimeout(timeoutId);
    if (!testCompleted) {
      const reasonStr = reason ? reason.toString() : `code=${code}`;
      console.log(`🔌 连接关闭: ${reasonStr}`);
      handleTestCompletion(ip, port, location, false, testRound, reasonStr);
    }
  });

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

  ws.on("unexpected-response", (request, response) => {
    console.log(`⚠️ 意外响应: HTTP ${response.statusCode}`);
    let body = "";
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      //console.log(`   响应体: ${body}`);
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

  if (result.successes + result.failures < TESTS_PER_IP) {
    const nextRound = result.successes + result.failures + 1;
    setTimeout(() => {
      createWebSocketConnection(ip, port, location, nextRound);
    }, 500);
  }

  startNextTest();

  if (completedTests === ipPortList.length * TESTS_PER_IP) {
    console.log("\n🎉 所有测试完成");
    saveResults();
    process.exit(0);
  }
}

function calculateAverage(latencies) {
  if (latencies.length === 0) return 0;
  const sum = latencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencies.length);
}

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

function startConcurrentTests() {
  console.log(
    `🚀 开始并发测试，每个IP测试${TESTS_PER_IP}次，最大并发数: ${MAX_CONCURRENT}`,
  );
  //console.log(`📋 UUID: ${vlessConfig.uuid}`);
  startNextTest();
}

function saveResults() {
  const top5Data = [];
  const allData = [];
  const countryOrder = {};
  const countryCounters = {};
  const top5Counters = {};

  const passedIPs = [];

  Object.values(testResults).forEach((result) => {
    if (result.successes === TESTS_PER_IP) {
      passedIPs.push({
        ...result,
        avgLatency: calculateAverage(result.latencies),
      });
    } else {
      /**console.log(
        `❌ 失败的IP: ${result.ip}:${result.port} - ${result.location} (成功: ${result.successes}/${TESTS_PER_IP})`,
      );*/
    }
  });

  passedIPs.sort((a, b) => a.avgLatency - b.avgLatency);

  //console.log(`\n📊 通过测试的IP: ${passedIPs.length}/${ipPortList.length}`);

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

  const sortedCountries = Object.keys(countryGroups).sort((a, b) => {
    return (countryOrder[a] || 0) - (countryOrder[b] || 0);
  });

  sortedCountries.forEach((country) => {
    countryCounters[country] = 1;
    top5Counters[country] = 1;
  });

  sortedCountries.forEach((country) => {
    const countryItems = countryGroups[country];

    countryItems.forEach((item) => {
      allData.push(
        `${item.ip}:${item.port}#${country}${countryCounters[country]} - ` +
          `${item.avgLatency}ms`,
      );
      countryCounters[country]++;
    });

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

  fs.writeFileSync("vless_top5.txt", top5Data.join("\n"), "utf8");
  fs.writeFileSync("vless_all.txt", allData.join("\n"), "utf8");
  saveDetailedResults(countryOrder);
}

function saveDetailedResults(countryOrder) {
  const detailedData = [];
  const failedData = [];

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

  const countryGroups = {};
  passedIPs.forEach((item) => {
    const countryBase = item.location.replace(/\d+$/, "").trim();
    if (!countryGroups[countryBase]) {
      countryGroups[countryBase] = [];
    }
    countryGroups[countryBase].push(item);
  });

  const sortedCountries = Object.keys(countryGroups).sort((a, b) => {
    return (countryOrder[a] || 0) - (countryOrder[b] || 0);
  });

  const tempCounters = {};
  sortedCountries.forEach((country) => {
    tempCounters[country] = 1;
  });

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

  Object.values(testResults).forEach((result) => {
    if (result.successes < TESTS_PER_IP) {
      failedData.push(`${result.ip}:${result.port}#${result.location}`);
    }
  });

  fs.writeFileSync(
    "vless_passed_detailed.txt",
    detailedData.join("\n"),
    "utf8",
  );
  fs.writeFileSync("vless_failed.txt", failedData.join("\n"), "utf8");

  console.log(`✅ 已保存详细通过结果到 vless_passed_detailed.txt`);
  console.log(`✅ 已保存失败结果到 vless_failed.txt`);
}

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

main();
