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

let testResults = {}; // 存储每个IP的测试结果 { "ip:port": { location, successes, failures, latencies } }
let completedTests = 0; // 已完成测试计数
let activeConnections = 0; // 活跃连接数
let nextTestIndex = 0; // 下一个要测试的IP索引
const MAX_CONCURRENT = 50; // 最大并发数
const TESTS_PER_IP = 4; // 每个IP测试次数

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
  fragment: "1,40-60,30-50,tlshello",
  encryption: "none",
  name: "测试",
};

// 从 JSON 配置生成连接参数
function getConnectionParams() {
  return {
    wsUrl: `wss://${vlessConfig.server}:${vlessConfig.port}${vlessConfig.path}`,
    headers: {
      Host: vlessConfig.host,
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": 13,
    },
    tlsOptions: {
      rejectUnauthorized: false,
      servername: vlessConfig.sni,
    },
  };
}

// 获取或创建测试结果对象
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

// 检查IP是否已完成所有测试
function isTestCompleted(ip, port) {
  const key = `${ip}:${port}`;
  const result = testResults[key];
  return result && result.successes + result.failures >= TESTS_PER_IP;
}

// 检查IP是否通过所有测试
function isPassed(ip, port) {
  const key = `${ip}:${port}`;
  const result = testResults[key];
  return result && result.successes === TESTS_PER_IP;
}

// 创建 WebSocket 客户端连接函数
function createWebSocketConnection(ip, port, location, testRound) {
  activeConnections++;

  const params = getConnectionParams();
  // 替换 URL 中的服务器地址和端口为当前测试的 IP 和端口
  const wsUrl = `wss://${ip}:${port}${vlessConfig.path}`;

  const tlsOptions = {
    rejectUnauthorized: false,
    servername: vlessConfig.sni,
    host: ip,
    port: port,
  };

  const result = getTestResult(ip, port, location);
  console.log(
    `🔄 开始测试 ${location} (${ip}:${port}) 第${testRound}/${TESTS_PER_IP}次 [活跃: ${activeConnections}, 已完成: ${completedTests}, 总测试数: ${ipPortList.length * TESTS_PER_IP}]`,
  );

  const ws = new WebSocket(wsUrl, {
    headers: params.headers,
    createConnection: () => tls.connect(tlsOptions),
    timeout: 5000,
  });

  let sendTime;
  let messageReceived = false;
  let timeoutId;
  let testCompleted = false; // 防止重复完成

  // 设置超时处理
  timeoutId = setTimeout(() => {
    if (!messageReceived && !testCompleted) {
      console.log(`⏰ 测试超时 ${location} (${ip}:${port}) 第${testRound}次`);
      ws.terminate();
      cleanup();
      if (!testCompleted) {
        testCompleted = true;
        handleTestCompletion(ip, port, location, false, testRound);
      }
    }
  }, 5000);

  function cleanup() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  ws.on("open", () => {
    console.log(`✅ 已建立连接 ${location} (${ip}:${port}) 第${testRound}次`);
    sendTime = Date.now();
    ws.send("ping");
  });

  ws.on("message", (data) => {
    if (messageReceived || testCompleted) return;
    messageReceived = true;

    console.log(
      `📨 已接收数据 from ${location} 第${testRound}次: ${data.toString()}`,
    );

    // 计算延迟
    const receiveTime = Date.now();
    const latency = receiveTime - sendTime;
    console.log(`✅ 延迟: ${latency} ms [${location}] 第${testRound}次`);

    ws.close();

    if (!testCompleted) {
      testCompleted = true;
      handleTestCompletion(ip, port, location, true, testRound, latency);
    }
  });

  ws.on("close", () => {
    console.log(`🔚 连接关闭 ${location} (${ip}:${port}) 第${testRound}次`);
    cleanup();
    if (!testCompleted) {
      testCompleted = true;
      handleTestCompletion(ip, port, location, false, testRound);
    }
  });

  ws.on("error", (error) => {
    console.log(
      `❌ 连接错误 ${location} (${ip}:${port}) 第${testRound}次: ${error.message}`,
    );
    cleanup();
    if (!testCompleted) {
      testCompleted = true;
      handleTestCompletion(ip, port, location, false, testRound);
    }
  });
}

// 处理测试完成
function handleTestCompletion(ip, port, location, success, testRound, latency) {
  const result = getTestResult(ip, port, location);

  if (success) {
    result.successes++;
    result.latencies.push(latency);
    console.log(
      `✅ 第${testRound}次测试成功 (${result.successes}/${TESTS_PER_IP} 成功)`,
    );
  } else {
    result.failures++;
    console.log(
      `❌ 第${testRound}次测试失败 (${result.failures}/${TESTS_PER_IP} 失败)`,
    );
  }

  activeConnections--;
  completedTests++;

  console.log(
    `📊 进度: ${completedTests}/${ipPortList.length * TESTS_PER_IP} 次测试 (活跃: ${activeConnections})`,
  );

  // 检查是否所有测试已完成
  if (result.successes + result.failures === TESTS_PER_IP) {
    result.completed = true;
    if (result.successes === TESTS_PER_IP) {
      console.log(
        `🎉 ${location} (${ip}:${port}) 全部${TESTS_PER_IP}次测试通过！平均延迟: ${calculateAverage(result.latencies)}ms`,
      );
    } else {
      console.log(
        `❌ ${location} (${ip}:${port}) 测试未通过 (成功: ${result.successes}/${TESTS_PER_IP})`,
      );
    }
  }

  // 如果这个IP还有剩余测试次数，继续测试
  if (result.successes + result.failures < TESTS_PER_IP) {
    const nextRound = result.successes + result.failures + 1;
    setTimeout(() => {
      createWebSocketConnection(ip, port, location, nextRound);
    }, 100); // 稍微延迟一下再开始下一次测试
  }

  // 启动下一个IP的测试
  startNextTest();

  // 所有测试完成
  if (completedTests === ipPortList.length * TESTS_PER_IP) {
    console.log("\n🎉 所有测试完成");
    saveResults();
    process.exit(0);
  }
}

// 计算平均延迟
function calculateAverage(latencies) {
  if (latencies.length === 0) return 0;
  const sum = latencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencies.length);
}

// 启动下一个测试
function startNextTest() {
  // 当活跃连接数小于最大并发数，且还有未开始测试的IP时，启动新测试
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

    // 检查这个IP是否已经开始测试
    if (result.successes + result.failures === 0) {
      // 第一次启动这个IP的测试
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

// 启动并发测试
function startConcurrentTests() {
  console.log(
    `🚀 开始并发测试，每个IP测试${TESTS_PER_IP}次，最大并发数: ${MAX_CONCURRENT}`,
  );
  startNextTest(); // 这会启动第一批测试
}

// 重新排序并保存结果
function saveResults() {
  const top5Data = [];
  const allData = [];
  const countryOrder = {}; // 记录每个国家的出现顺序
  const countryCounters = {};
  const top5Counters = {};

  // 收集通过的IP（按平均延迟排序）
  const passedIPs = [];

  Object.values(testResults).forEach((result) => {
    if (result.successes === TESTS_PER_IP) {
      passedIPs.push({
        ...result,
        avgLatency: calculateAverage(result.latencies),
      });
    }
  });

  // 按平均延迟排序
  passedIPs.sort((a, b) => a.avgLatency - b.avgLatency);

  console.log(`\n📊 通过测试的IP: ${passedIPs.length}/${ipPortList.length}`);

  // 按国家分组
  const countryGroups = {};
  passedIPs.forEach((item) => {
    const countryBase = item.location.replace(/\d+$/, "").trim();
    if (!countryGroups[countryBase]) {
      countryGroups[countryBase] = [];
      // 记录国家出现的顺序
      if (!countryOrder[countryBase]) {
        countryOrder[countryBase] = Object.keys(countryOrder).length;
      }
    }
    countryGroups[countryBase].push(item);
  });

  // 按国家顺序排序（保持原来的顺序）
  const sortedCountries = Object.keys(countryGroups).sort((a, b) => {
    return (countryOrder[a] || 0) - (countryOrder[b] || 0);
  });

  // 初始化计数器
  sortedCountries.forEach((country) => {
    countryCounters[country] = 1;
    top5Counters[country] = 1;
  });

  // 按国家顺序生成数据
  sortedCountries.forEach((country) => {
    const countryItems = countryGroups[country];

    // 生成该国家的所有数据
    countryItems.forEach((item) => {
      allData.push(
        `${item.ip}:${item.port}#${country}${countryCounters[country]}`,
      );
      countryCounters[country]++;
    });

    // 生成该国家的前5个数据
    countryItems.forEach((item, index) => {
      if (index < 5) {
        top5Data.push(
          `${item.ip}:${item.port}#${country}${top5Counters[country]}`,
        );
        top5Counters[country]++;
      }
    });
  });

  // 保存每个国家前5个到文件
  fs.writeFileSync("vless_top5.txt", top5Data.join("\n"), "utf8");
  console.log(
    `✅ 已保存每个国家前5个到 vless_top5.txt (${top5Data.length} 个)`,
  );

  // 保存全部到文件
  fs.writeFileSync("vless_all.txt", allData.join("\n"), "utf8");
  console.log(`✅ 已保存全部通过IP到 vless_all.txt (${allData.length} 个)`);

  // 保存详细测试结果
  saveDetailedResults(countryOrder);
}

// 保存详细的测试结果
function saveDetailedResults(countryOrder) {
  const detailedData = [];
  const failedData = [];

  // 收集通过的IP（按平均延迟排序）
  const passedIPs = [];

  Object.values(testResults).forEach((result) => {
    if (result.successes === TESTS_PER_IP) {
      passedIPs.push({
        ...result,
        avgLatency: calculateAverage(result.latencies),
      });
    }
  });

  // 按平均延迟排序
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

  // 按国家顺序排序（保持原来的顺序）
  const sortedCountries = Object.keys(countryGroups).sort((a, b) => {
    return (countryOrder[a] || 0) - (countryOrder[b] || 0);
  });

  // 初始化计数器
  const tempCounters = {};
  sortedCountries.forEach((country) => {
    tempCounters[country] = 1;
  });

  // 按国家顺序生成详细数据
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

  // 处理失败的IP - 也按国家分组
  const failedGroups = {};
  Object.values(testResults).forEach((result) => {
    if (result.successes < TESTS_PER_IP) {
      const countryBase = result.location.replace(/\d+$/, "").trim();
      if (!failedGroups[countryBase]) {
        failedGroups[countryBase] = [];
      }
      failedGroups[countryBase].push(result);
    }
  });

  // 按国家顺序生成失败数据
  const failedCounters = {};
  sortedCountries.forEach((country) => {
    if (failedGroups[country]) {
      failedCounters[country] = 1;
      failedGroups[country].forEach((item) => {
        failedData.push(
          `${item.ip}:${item.port}#${country}${failedCounters[country]} - ` +
            `成功:${item.successes}/${TESTS_PER_IP}`,
        );
        failedCounters[country]++;
      });
    }
  });

  // 添加其他不在sortedCountries中的国家（如果有）
  Object.keys(failedGroups).forEach((country) => {
    if (!sortedCountries.includes(country)) {
      failedCounters[country] = 1;
      failedGroups[country].forEach((item) => {
        failedData.push(
          `${item.ip}:${item.port}#${country}${failedCounters[country]} - ` +
            `成功:${item.successes}/${TESTS_PER_IP}`,
        );
        failedCounters[country]++;
      });
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

// 主函数
function main() {
  console.log("🚀 开始加载 IP 列表...");
  loadIpPortList("ip_all.txt");

  console.log(`📋 共加载 ${ipPortList.length} 个测试点`);
  console.log(
    `📋 每个IP测试 ${TESTS_PER_IP} 次，总共 ${ipPortList.length * TESTS_PER_IP} 次测试`,
  );

  if (ipPortList.length > 0) {
    console.log(""); // 空行
    startConcurrentTests();
  } else {
    console.log("❌ 没有找到可测试的 IP");
  }
}

main();
