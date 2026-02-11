import { promises as fs } from 'fs';
import net from 'net';
import fetch from "node-fetch";

const IPS_CSV = 'init.csv';
const LOCATIONS_JSON = 'locations.json';
const OUTPUT_FILE = 'proxyip.txt';
const CONCURRENCY_LIMIT = 20;
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
 * 从trace响应中提取ip和colo字段
 */
const extractFromTrace = (traceText) => {
  const lines = traceText.split('\n');
  const result = {};
  
  lines.forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      result[key.trim()] = value.trim();
    }
  });
  
  return {
    ip: result.ip || null,
    colo: result.colo || null
  };
};

/**
 * 读取ips.csv文件，手动解析CSV，获取IP地址和端口号
 */
async function readIpsCsv() {
  try {
    const content = await fs.readFile(IPS_CSV, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
      throw new Error('CSV文件为空');
    }

    // 解析表头
    const headers = lines[0].split(',').map(h => h.trim());
    const ipIndex = headers.findIndex(h => h.includes('IP') || h.includes('ip'));
    const portIndex = headers.findIndex(h => h.includes('端口') || h.includes('port'));
    
    if (ipIndex === -1 || portIndex === -1) {
      throw new Error('CSV文件中未找到IP地址或端口号列');
    }

    console.log(`📋 解析CSV: IP列[${ipIndex}], 端口列[${portIndex}]`);

    // 解析数据行
    const proxyList = [];
    for (let i = 1; i < lines.length; i++) {
      const columns = lines[i].split(',');
      if (columns.length > Math.max(ipIndex, portIndex)) {
        const ip = columns[ipIndex]?.trim();
        const port = columns[portIndex]?.trim();
        
        if (ip && port && net.isIP(ip) && !isNaN(parseInt(port))) {
          proxyList.push(`${ip}:${port}`);
        }
      }
    }
    
    console.log(`📊 加载完成: ${proxyList.length} 个IP (共${lines.length-1}行)`);
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
    const content = await fs.readFile(LOCATIONS_JSON, 'utf8');
    const locations = JSON.parse(content);
    
    // 创建colo映射表
    const coloMap = new Map();
    locations.forEach(location => {
      if (location.iata && location.country && location.emoji) {
        coloMap.set(location.iata, {
          country: location.country,
          emoji: location.emoji,
          region: location.region || ''
        });
      }
    });
    
    console.log(`📊 加载完成: ${LOCATIONS_JSON}`);
    return coloMap;
  } catch (error) {
    console.error(`❌ 读取失败 ${LOCATIONS_JSON}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 检测单个代理
 */
/**
 * 检测单个代理
 */
/**
 * 检测单个代理
 */
async function checkProxy(proxyAddress, coloMap) {
  const url = `https://${proxyAddress}/cdn-cgi/trace`;
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      console.log(`  ❌ ${proxyAddress.padEnd(21)} ${response.status} (${elapsed}ms)`);
      return null;
    }

    const data = await response.text();
    const { ip, colo } = extractFromTrace(data);

    if (!ip) {
      console.log(`  ⚠️ ${proxyAddress.padEnd(21)} 无IP信息 (${elapsed}ms)`);
      return null;
    }

    // 获取colo信息（如果存在）
    let locationInfo = null;
    let countryDisplay = '';
    if (colo && coloMap.has(colo)) {
      locationInfo = coloMap.get(colo);
      countryDisplay = `${locationInfo.emoji} ${locationInfo.country}`;
    }

    // IPv6出口
    if (isIPv6(ip)) {
      if (locationInfo) {
        console.log(`  ⚠️ ${proxyAddress.padEnd(21)} IPv6出口 ${countryDisplay} (${elapsed}ms)`);
      } else {
        console.log(`  ⚠️ ${proxyAddress.padEnd(21)} IPv6出口 COLO:${colo || '未知'} (${elapsed}ms)`);
      }
      return null; // IPv6始终不加入结果
    }

    // IPv4出口 - 输出日志
    if (locationInfo) {
      console.log(`  ✅ ${proxyAddress.padEnd(21)} IPv4出口 ${countryDisplay} (${elapsed}ms)`);
    } else {
      console.log(`  ✅ ${proxyAddress.padEnd(21)} IPv4出口 COLO:${colo || '未知'} (${elapsed}ms)`);
    }

    // 只有IPv4且colo在locations.json中的才加入结果
    if (!colo || !coloMap.has(colo)) {
    console.log('数据库')
      return null;
    }

    const formattedResult = `${proxyAddress}#${locationInfo.emoji} ${locationInfo.country}`;
    return formattedResult;

  } catch (error) {
    const elapsed = Date.now() - startTime;
    if (error.name === 'AbortError') {
      console.log(`  ⏱️ ${proxyAddress.padEnd(21)} 超时 (${elapsed}ms)`);
    } else {
      console.log(`  ❌ ${proxyAddress.padEnd(21)} 连接失败 (${elapsed}ms)`);
    }
    return null;
  }
}
/**
 * 并发控制处理器
 */
async function processBatch(items, concurrency, processor, coloMap) {
  const results = [];
  const total = items.length;
  let processed = 0;
  
  console.log(`\n🚀 开始检测 ${total} 个 Proxyip (并发${concurrency}, 超时${TIMEOUT_MS/1000}s)\n`);
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(item => processor(item, coloMap))
    );
    
    results.push(...batchResults.filter(Boolean));
    processed += batch.length;
    
    const percent = ((processed / total) * 100).toFixed(1);
    console.log(`  📊 进度: ${processed}/${total} (${percent}%) | 有效: ${results.length}\n`);
  }
  
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
  
  console.log('='.repeat(60));
  console.log('📊 检测完成统计');
  console.log('='.repeat(60));
  console.log(`  总 Proxyip 数:    ${total}`);
  console.log(`  ✅ 可用:     ${valid} (${successRate}%)`);
  console.log(`  ❌ 无效:     ${invalid}`);
  console.log(`  ⏱️  耗时:     ${elapsedTime.toFixed(1)}s`);
  console.log(`  ⚡ 平均速度:  ${(total / elapsedTime).toFixed(1)}个/秒`);
  console.log('='.repeat(60));
}

/**
 * 主函数
 */
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Cloudflare CDN Proxyip 检测工具 v2.0');
  console.log('='.repeat(60) + '\n');
  
  const startTime = Date.now();
  
  try {
    // 读取ips.csv
    console.log('📖 读取配置文件...');
    const proxyAddresses = await readIpsCsv();
    
    if (proxyAddresses.length === 0) {
      console.log('⚠️ 没有IP地址，程序退出');
      return;
    }
    
    // 读取locations.json
    const coloMap = await readLocationsJson();
    
    // 批量检测代理
    const validProxies = await processBatch(
      proxyAddresses,
      CONCURRENCY_LIMIT,
      checkProxy,
      coloMap
    );

    // 计算总耗时
    const totalTime = (Date.now() - startTime) / 1000;
    
    // 打印统计摘要
    printSummary(proxyAddresses, validProxies, totalTime);

    // 保存结果
    if (validProxies.length > 0) {
      await fs.writeFile(OUTPUT_FILE, validProxies.join('\n'), 'utf8');
      console.log(`💾 已保存: ${OUTPUT_FILE} (${validProxies.length}条)`);
      
      // 生成纯净IP:端口列表
      const ipPortList = validProxies.map(proxy => proxy.split('#')[0]);
      await fs.writeFile('proxyip_clean.txt', ipPortList.join('\n'), 'utf8');
      console.log(`💾 已保存: proxyip_clean.txt (纯净列表)`);
      
      console.log('\n📋 前10个可用 Proxyip:');
      validProxies.slice(0, 10).forEach((proxy, index) => {
        console.log(`  ${index + 1}. ${proxy}`);
      });
      
      if (validProxies.length > 10) {
        console.log(`  ... 共${validProxies.length}条`);
      }
      
    } else {
      console.log('\n⚠️ 未找到可用 Proxyip，不保存文件');
    }

    console.log('\n✨ 检测完成\n');

  } catch (error) {
    console.error(`\n❌ 程序异常: ${error.message}`);
    process.exit(1);
  }
}

// 执行主函数
main();