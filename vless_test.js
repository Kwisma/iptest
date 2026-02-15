import fs from 'fs';
import WebSocket from 'ws';
import tls from 'tls';

// IP 和端口列表（包含备注）
let ipPortList = [];

// 从文件读取 ipPortList
function loadIpPortList(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        const [ipPort, location] = line.split('#');
        const [ip, port] = ipPort.split(':');
        ipPortList.push({ ip, port: parseInt(port), location: location?.trim() || 'Unknown' });
      }
    });
  } catch (err) {
    console.error('读取文件失败:', err);
  }
}

let latencyData = {};
let completedTests = 0; // 已完成测试计数
let activeConnections = 0; // 活跃连接数
let nextTestIndex = 0; // 下一个要测试的IP索引
const MAX_CONCURRENT = 50; // 最大并发数

// 解析 vless 链接
const vlessUrl = 'vless://00000000-0000-4000-8000-000000000000@91.107.175.82:12001?security=tls&sni=sub.mot.ip-ddns.com&type=ws&host=sub.mot.ip-ddns.com&path=%2F&fragment=1%2C40-60%2C30-50%2Ctlshello&encryption=none#%F0%9F%87%A9%F0%9F%87%AA%E5%BE%B7%E5%9B%BD1%40Marisa_kristi';

// 创建 WebSocket 客户端连接函数
function createWebSocketConnection(ip, port, location) {
  activeConnections++;
  
  const parsedUrl = new URL(vlessUrl);
  const wsUrl = `wss://${ip}:${port}${parsedUrl.pathname || '/'}`;

  const tlsOptions = {
    rejectUnauthorized: false,
    servername: parsedUrl.searchParams.get('sni'),
    host: ip,
    port: port,
  };

  console.log(`🔄 开始测试 ${location} (${ip}:${port}) [活跃: ${activeConnections}, 已完成: ${completedTests}, 总: ${ipPortList.length}]`);
  
  const ws = new WebSocket(wsUrl, {
    headers: {
      'Host': parsedUrl.searchParams.get('host'),
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': 13,
    },
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
      console.log(`⏰ 测试超时 ${location} (${ip}:${port})`);
      ws.terminate();
      cleanup();
      if (!testCompleted) {
        testCompleted = true;
        testComplete();
      }
    }
  }, 5000);

  function cleanup() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  ws.on('open', () => {
    console.log(`✅ 已建立连接 ${location} (${ip}:${port})`);
    sendTime = Date.now();
    ws.send('ping');
  });

  ws.on('message', (data) => {
    if (messageReceived || testCompleted) return;
    messageReceived = true;
    
    console.log(`📨 已接收数据 from ${location}: ${data.toString()}`);

    // 计算延迟
    const receiveTime = Date.now();
    const latency = receiveTime - sendTime;
    console.log(`✅ 延迟: ${latency} ms [${location}]`);

    // 保存延迟数据
    if (!latencyData[location]) {
      latencyData[location] = [];
    }
    latencyData[location].push({ ip, port, latency });

    ws.close();
  });

  ws.on('close', () => {
    console.log(`🔚 连接关闭 ${location} (${ip}:${port})`);
    cleanup();
    if (!testCompleted) {
      testCompleted = true;
      testComplete();
    }
  });

  ws.on('error', (error) => {
    console.log(`❌ 连接错误 ${location} (${ip}:${port}): ${error.message}`);
    cleanup();
    if (!testCompleted) {
      testCompleted = true;
      testComplete();
    }
  });
}

// 测试完成处理
function testComplete() {
  activeConnections--;
  completedTests++;
  
  console.log(`📊 进度: ${completedTests}/${ipPortList.length} (活跃: ${activeConnections})`);
  
  // 启动下一个测试（如果还有）
  startNextTest();
  
  // 所有测试完成
  if (completedTests === ipPortList.length) {
    console.log('\n🎉 所有测试完成');
    saveResults();
    process.exit(0);
  }
}

// 启动下一个测试
function startNextTest() {
  // 当活跃连接数小于最大并发数，且还有未测试的IP时，启动新测试
  while (activeConnections < MAX_CONCURRENT && nextTestIndex < ipPortList.length) {
    const nextIpPort = ipPortList[nextTestIndex];
    nextTestIndex++;
    createWebSocketConnection(nextIpPort.ip, nextIpPort.port, nextIpPort.location);
  }
}

// 启动并发测试
function startConcurrentTests() {
  console.log(`🚀 开始并发测试，最大并发数: ${MAX_CONCURRENT}`);
  startNextTest(); // 这会启动第一批测试
}

// 重新排序并保存结果
function saveResults() {
  const top5Data = [];
  const allData = [];
  const countryCounters = {};
  const top5Counters = {};
  
  // 初始化计数器
  ipPortList.forEach(item => {
    const countryBase = item.location.replace(/\d+$/, '').trim();
    if (!countryCounters[countryBase]) {
      countryCounters[countryBase] = 1;
    }
    if (!top5Counters[countryBase]) {
      top5Counters[countryBase] = 1;
    }
  });
  
  // 遍历原始顺序，生成全部保存的数据
  ipPortList.forEach(item => {
    const country = item.location;
    const ip = item.ip;
    const port = item.port;
    const countryBase = country.replace(/\d+$/, '').trim();
    
    const hasResult = latencyData[country]?.some(
      result => result.ip === ip && result.port === port
    );
    
    if (hasResult) {
      allData.push(`${ip}:${port}#${countryBase}${countryCounters[countryBase]}`);
      countryCounters[countryBase]++;
    }
  });

  // 再次遍历原始顺序，生成每个国家前5个的数据
  ipPortList.forEach(item => {
    const country = item.location;
    const ip = item.ip;
    const port = item.port;
    const countryBase = country.replace(/\d+$/, '').trim();
    
    const hasResult = latencyData[country]?.some(
      result => result.ip === ip && result.port === port
    );
    
    if (hasResult && top5Counters[countryBase] <= 5) {
      top5Data.push(`${ip}:${port}#${countryBase}${top5Counters[countryBase]}`);
      top5Counters[countryBase]++;
    } else if (hasResult) {
      top5Counters[countryBase]++;
    }
  });

  // 保存每个国家前5个到文件
  fs.writeFileSync('vless_top5.txt', top5Data.join('\n'), 'utf8');

  // 保存全部到文件
  fs.writeFileSync('vless_all.txt', allData.join('\n'), 'utf8');
  
  // 保存带延迟的详细版本
  // saveDetailedResults();
}

// 保存带延迟的详细结果
function saveDetailedResults() {
  const detailedData = [];
  const tempCounters = {};
  
  ipPortList.forEach(item => {
    const country = item.location;
    const ip = item.ip;
    const port = item.port;
    
    const countryBase = country.replace(/\d+$/, '').trim();
    
    if (!tempCounters[countryBase]) {
      tempCounters[countryBase] = 1;
    }
    
    const result = latencyData[country]?.find(
      r => r.ip === ip && r.port === port
    );
    
    if (result) {
      detailedData.push(`${ip}:${port}#${countryBase}${tempCounters[countryBase]} - ${result.latency}ms`);
      tempCounters[countryBase]++;
    }
  });
  
  fs.writeFileSync('vless_test.txt', detailedData.join('\n'), 'utf8');
}

// 主函数
function main() {
  console.log('🚀 开始加载 IP 列表...');
  loadIpPortList('ip_all.txt');
  
  console.log(`📋 共加载 ${ipPortList.length} 个测试点`);
  
  if (ipPortList.length > 0) {
    console.log(''); // 空行
    startConcurrentTests();
  } else {
    console.log('❌ 没有找到可测试的 IP');
  }
}

main();