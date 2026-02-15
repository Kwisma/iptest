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

const vlessConfig = {
  protocol: "vless",
  uuid: "00000000-0000-4000-8000-000000000000",
  server: "127.0.0.1",
  port: 443,
  security: "tls",
  sni: "sub.mot.ip-ddns.com",
  type: "ws",
  host: "sub.mot.ip-ddns.com",
  path: "/",
  encryption: "none",
  name: "测试",
};

function getConnectionParams() {
  return {
    wsUrl: `wss://${vlessConfig.server}:${vlessConfig.port}${vlessConfig.path}`,
    headers: {
      Host: vlessConfig.host,
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": 13,
      Upgrade: "websocket",
      Connection: "Upgrade",
    },
    tlsOptions: {
      rejectUnauthorized: false,
      servername: vlessConfig.sni,
    },
  };
}

// 生成VLESS协议请求数据包（只握手，不发送实际数据）
function generateVLESSHandshake() {
  // 将UUID从字符串转为字节数组
  const uuidStr = vlessConfig.uuid.replace(/-/g, "");
  const uuidBytes = new Uint8Array(16);
  for (let i = 0; i < 32; i += 2) {
    uuidBytes[i / 2] = parseInt(uuidStr.substring(i, i + 2), 16);
  }

  // 构建VLESS请求头
  // 格式: 版本(1) + UUID(16) + 附加长度(1) + 端口(2) + 地址类型(1) + 地址

  // 版本: 0
  const version = new Uint8Array([0]);

  // 附加数据长度: 0
  const addonsLen = new Uint8Array([0]);

  // 目标端口 (使用一个常见端口)
  const portBytes = new Uint8Array(2);
  const portView = new DataView(portBytes.buffer);
  portView.setUint16(0, 80); // 使用80端口

  // 地址类型: 2 (域名)
  const addrType = new Uint8Array([2]);

  // 目标域名 (使用一个简单域名)
  const targetHost = "www.google.com";
  const hostBytes = new TextEncoder().encode(targetHost);
  const hostLen = new Uint8Array([hostBytes.length]);

  // 合并请求头
  const headerLength = 1 + 16 + 1 + 2 + 1 + 1 + hostBytes.length;
  const request = new Uint8Array(headerLength);

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
  request.set(hostLen, offset);
  offset += 1;
  request.set(hostBytes, offset);

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

  const params = getConnectionParams();
  const wsUrl = `wss://${ip}:${port}${vlessConfig.path}`;

  const tlsOptions = {
    rejectUnauthorized: false,
    servername: vlessConfig.sni,
    host: ip,
    port: port,
  };

  const result = getTestResult(ip, port, location);

  console.log(
    `🔄 测试 ${location} (${ip}:${port}) 第${testRound}/${TESTS_PER_IP}次 [活跃: ${activeConnections}, 已完成: ${completedTests}]`,
  );

  const ws = new WebSocket(wsUrl, {
    headers: params.headers,
    createConnection: () => tls.connect(tlsOptions),
    handshakeTimeout: 5000,
  });

  let handshakeTime;
  let handshakeReceived = false;
  let timeoutId;
  let testCompleted = false;

  timeoutId = setTimeout(() => {
    if (!testCompleted && !handshakeReceived) {
      console.log(`⏰ 超时 ${location} (${ip}:${port}) 第${testRound}次`);
      ws.terminate();
      handleTestCompletion(ip, port, location, false, testRound, "timeout");
    }
  }, 5000);

  ws.on("open", () => {
    console.log(
      `✅ WebSocket连接成功 ${location} (${ip}:${port}) 第${testRound}次`,
    );
    handshakeTime = Date.now();

    // 发送VLESS握手请求
    const vlessHandshake = generateVLESSHandshake();
    ws.send(vlessHandshake);
    console.log(`📤 已发送VLESS握手请求`);
  });

  ws.on("message", (data) => {
    if (testCompleted) return;

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // 检查是否是服务端的握手响应 (前两个字节是 [version, 0])
    if (chunk.length >= 2 && chunk[1] === 0) {
      const handshakeTime_ms = Date.now() - handshakeTime;
      console.log(
        `🎉 VLESS握手成功 ${location} 第${testRound}次! 耗时: ${handshakeTime_ms}ms`,
      );
      console.log(`VLESS握手数据：${chunk}`);

      handshakeReceived = true;

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
    }
  });

  ws.on("close", () => {
    clearTimeout(timeoutId);
    if (!testCompleted && !handshakeReceived) {
      handleTestCompletion(ip, port, location, false, testRound, "closed");
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
}

function handleTestCompletion(ip, port, location, success, testRound, details) {
  const result = getTestResult(ip, port, location);

  if (success) {
    result.successes++;
    if (typeof details === "number") {
      result.latencies.push(details);
    }
    console.log(
      `✅ 第${testRound}次测试成功 (${result.successes}/${TESTS_PER_IP})`,
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
    if (result.successes === TESTS_PER_IP) {
      console.log(
        `🎉 ${location} (${ip}:${port}) 全部通过！平均延迟: ${calculateAverage(result.latencies)}ms`,
      );
    } else {
      console.log(
        `❌ ${location} (${ip}:${port}) 测试未通过 (成功: ${result.successes}/${TESTS_PER_IP})`,
      );
    }
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
  console.log(`📋 判断标准: VLESS握手成功即视为通过`);
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
      console.log(
        `❌ 失败的IP: ${result.ip}:${result.port} - ${result.location} (成功: ${result.successes}/${TESTS_PER_IP})`,
      );
    }
  });

  passedIPs.sort((a, b) => a.avgLatency - b.avgLatency);

  console.log(`\n📊 通过测试的IP: ${passedIPs.length}/${ipPortList.length}`);

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
        `${item.ip}:${item.port}#${country}${countryCounters[country]}`,
      );
      countryCounters[country]++;
    });

    countryItems.forEach((item, index) => {
      if (index < 5) {
        top5Data.push(
          `${item.ip}:${item.port}#${country}${top5Counters[country]}`,
        );
        top5Counters[country]++;
      }
    });
  });

  fs.writeFileSync("vless_top5.txt", top5Data.join("\n"), "utf8");
  console.log(
    `✅ 已保存每个国家前5个到 vless_top5.txt (${top5Data.length} 个)`,
  );

  fs.writeFileSync("vless_all.txt", allData.join("\n"), "utf8");
  console.log(`✅ 已保存全部通过IP到 vless_all.txt (${allData.length} 个)`);

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
          `平均:${item.avgLatency}ms [${latenciesStr}]`,
      );
      tempCounters[country]++;
    });
  });

  Object.values(testResults).forEach((result) => {
    if (result.successes < TESTS_PER_IP) {
      const countryBase = result.location.replace(/\d+$/, "").trim();
      failedData.push(
        `${result.ip}:${result.port}#${countryBase} - ` +
          `成功:${result.successes}/${TESTS_PER_IP}`,
      );
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
  console.log(
    `📋 每个IP测试 ${TESTS_PER_IP} 次，总共 ${ipPortList.length * TESTS_PER_IP} 次测试`,
  );

  if (ipPortList.length > 0) {
    console.log("");
    startConcurrentTests();
  } else {
    console.log("❌ 没有找到可测试的 IP");
  }
}

main();
