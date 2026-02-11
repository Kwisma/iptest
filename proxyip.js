import { promises as fs } from 'fs';
import net from 'net';
import fetch from "node-fetch";

const INPUT_FILE = 'ip_tq_unlimited.txt';
const OUTPUT_FILE = 'proxyip.txt';
const FILTER_STRING = '#🇯🇵日本';
const CONCURRENCY_LIMIT = 10;
const TIMEOUT_MS = 10000;

// 请求头
const headers = {
  "Host": "speed.cloudflare.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Connection": "keep-alive",
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate, br"
};

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
 * 判断代理
 */
const isJapanProxy = (proxyLine) => {
  return proxyLine.includes(FILTER_STRING);
};

/**
 * 解析代理行，提取IP和端口
 */
const parseProxyLine = (proxyLine) => {
  const trimmed = proxyLine.trim();
  if (!trimmed) return null;
  const [ipPort] = trimmed.split('#');
  return ipPort.trim();
};

/**
 * 直连访问trace接口
 */
async function checkProxy(proxyLine) {
  const cleanIpPort = parseProxyLine(proxyLine);
  if (!cleanIpPort) return null;

  const url = `https://${cleanIpPort}/cdn-cgi/trace`;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`❌ ${cleanIpPort} - 状态码: ${response.status}`);
      return null;
    }

    const data = await response.text();
    const ip = extractIpFromTrace(data);

    if (!ip) {
      console.log(`❌ ${cleanIpPort} - 无法提取IP`);
      return null;
    }

    if (isIPv6(ip)) {
      console.log(`❌ ${cleanIpPort} - 出站IPv6: ${ip}`);
      return null;
    }

    console.log(`✅ ${cleanIpPort} - 出站IPv4: ${ip}`);
    return proxyLine;

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`❌ ${cleanIpPort} - 超时`);
    } else {
      console.log(`❌ ${cleanIpPort} - 错误: ${error.message}`);
    }
    return null;
  }
}

/**
 * 并发控制处理器
 */
async function processBatch(items, concurrency, processor) {
  const results = [];
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(item => processor(item))
    );
    
    results.push(...batchResults.filter(Boolean));
    
    // 显示进度
    const processed = Math.min(i + concurrency, items.length);
    console.log(`📊 进度: ${processed}/${items.length}`);
  }
  
  return results;
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log('📖 读取代理列表...');
    
    // 读取输入文件
    const content = await fs.readFile(INPUT_FILE, 'utf8');
    const allLines = content.split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    
    console.log(`📊 共找到 ${allLines.length} 个代理`);
    
    // 筛选代理
    const japanProxies = FILTER_STRING 
      ? allLines.filter(isJapanProxy)
      : allLines;
    
    console.log(`${FILTER_STRING} 代理: ${japanProxies.length} 个\n`);

    if (japanProxies.length === 0) {
      console.log('⚠️ 没有找到符合条件的代理');
      return;
    }

    console.log('🚀 开始测试代理...\n');
    
    const validProxies = await processBatch(
      japanProxies, 
      CONCURRENCY_LIMIT, 
      checkProxy
    );

    console.log('\n📝 结果统计:');
    console.log(`✅ 可用代理: ${validProxies.length}`);
    console.log(`❌ 无效代理: ${japanProxies.length - validProxies.length}`);

    // 保存结果
    if (validProxies.length > 0) {
      await fs.writeFile(OUTPUT_FILE, validProxies.join('\n'), 'utf8');
      console.log(`💾 已保存到: ${OUTPUT_FILE}`);
      
      console.log('\n📋 保存的代理:');
      validProxies.forEach((proxy, index) => {
        console.log(`  ${index + 1}. ${proxy}`);
      });
      const formattedProxies = validProxies.map(proxy => {
    const match = proxy.match(/^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+)#/);
    return match ? match[1] : null; // 提取到的 ip:port 部分
});
      console.log('格式化：', JSON.stringify(formattedProxies))
    } else {
      console.log('⚠️ 没有可用的代理，不保存文件');
    }

  } catch (error) {
    console.error('❌ 程序执行出错:', error);
    process.exit(1);
  }
}

// 执行主函数
main();