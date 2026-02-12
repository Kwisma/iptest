import { promises as fs } from "fs";
import net from "net";
import fetch from "node-fetch";

const INPUT_FILE = "ip_tq_unlimited.txt";
const OUTPUT_FILE_ALL = "proxyip_all.txt"; // 所有可用代理
const OUTPUT_FILE_TOP5 = "proxyip_top5.txt"; // 每个地区前5个
const FILTER_STRING = "#🇯🇵日本"; // 过滤指定的地区
const CONCURRENCY_LIMIT = 10;
const TIMEOUT_MS = 10000;
const TOP5_LIMIT = 5; // 每个地区保留5个

// 请求头
const headers = {
  Host: "speed.cloudflare.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  Connection: "keep-alive",
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br",
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
      method: "GET",
      headers,
      signal: controller.signal,
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
    return {
      original: proxyLine,
      ipPort: cleanIpPort,
      tag: extractProxyTag(proxyLine),
      baseTag: extractBaseTag(extractProxyTag(proxyLine) || ""),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      console.log(`❌ ${cleanIpPort} - 超时`);
    } else {
      console.log(`❌ ${cleanIpPort} - 错误: ${error.message}`);
    }
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
  // 按基础标签分组
  const groups = groupByBaseTag(validProxyObjects);

  const reordered = [];

  // 对每个标签组内部重新编号
  Object.keys(groups)
    .sort()
    .forEach((baseTag) => {
      const groupProxies = groups[baseTag];

      groupProxies.forEach((proxy, index) => {
        // 重新编号，从1开始
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
  // 按基础标签分组
  const groups = groupByBaseTag(validProxyObjects);

  const selected = [];

  // 对每个标签组，只取前limit个
  Object.keys(groups)
    .sort()
    .forEach((baseTag) => {
      const groupProxies = groups[baseTag];
      const topN = groupProxies.slice(0, limit);

      topN.forEach((proxy, index) => {
        // 重新编号，从1开始
        const newProxyLine = `${proxy.ipPort}${baseTag}${index + 1}`;
        selected.push(newProxyLine);
      });
    });

  return selected;
};

/**
 * 并发控制处理器
 */
async function processBatch(items, concurrency, processor) {
  const results = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((item) => processor(item)),
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
    console.log("📖 读取代理列表...");

    // 读取输入文件
    const content = await fs.readFile(INPUT_FILE, "utf8");
    const allLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    console.log(`📊 共找到 ${allLines.length} 个代理`);

    // 筛选指定地区的代理
    const filteredProxies = FILTER_STRING
      ? allLines.filter(isFilteredProxy)
      : allLines;

    console.log(`🔍 过滤条件: ${FILTER_STRING}`);
    console.log(`📊 符合条件的代理: ${filteredProxies.length} 个\n`);

    if (filteredProxies.length === 0) {
      console.log("⚠️ 没有找到符合条件的代理");
      return;
    }

    console.log("🚀 开始测试代理...\n");

    const validProxyObjects = await processBatch(
      filteredProxies,
      CONCURRENCY_LIMIT,
      checkProxy,
    );

    console.log("\n📝 结果统计:");
    console.log(`✅ 可用代理: ${validProxyObjects.length}`);
    console.log(
      `❌ 无效代理: ${filteredProxies.length - validProxyObjects.length}`,
    );

    // 分组统计
    const groups = groupByBaseTag(validProxyObjects);
    console.log("\n📊 分组统计:");
    Object.keys(groups)
      .sort()
      .forEach((baseTag) => {
        console.log(`  ${baseTag}: ${groups[baseTag].length} 个代理`);
      });

    // 1. 所有可用代理（重新编号）
    const reorderedProxies = reorderProxies(validProxyObjects);

    // 2. 每个地区前5个代理
    const top5Proxies = selectTopNPerGroup(validProxyObjects, TOP5_LIMIT);

    // 保存结果 - 所有代理
    if (reorderedProxies.length > 0) {
      await fs.writeFile(OUTPUT_FILE_ALL, reorderedProxies.join("\n"), "utf8");
      console.log(
        `\n💾 所有代理已保存到: ${OUTPUT_FILE_ALL} (共 ${reorderedProxies.length} 个)`,
      );
    }

    // 保存结果 - 每个地区前5个
    if (top5Proxies.length > 0) {
      await fs.writeFile(OUTPUT_FILE_TOP5, top5Proxies.join("\n"), "utf8");
      console.log(
        `💾 每个地区前${TOP5_LIMIT}个代理已保存到: ${OUTPUT_FILE_TOP5} (共 ${top5Proxies.length} 个)`,
      );

      console.log("\n📋 每个地区前5个代理:");
      top5Proxies.forEach((proxy, index) => {
        console.log(`  ${index + 1}. ${proxy}`);
      });

      const formattedProxies = reorderedProxies.map((proxy) => {
        const match = proxy.match(/^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+)#/);
        return match ? match[1] : null;
      });
      console.log("\n格式化：", JSON.stringify(formattedProxies));
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
