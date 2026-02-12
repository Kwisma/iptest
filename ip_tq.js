import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

// 配置参数
const CONFIG = {
  perCountryCount: 5, // 每个国家最小记录数，小于此数量的国家不提取
  filterBySpeed: true, // 是否过滤下载速度
  minSpeed: 100, // 过滤下载速度下限，单位kb/s
  targetFile: "ip_tq.csv", // 指定要处理的CSV文件名
  outboundType: "all", // 出站IP类型: 'ipv4' (只保存IPv4), 'ipv6' (只保存IPv6), 'all' (都保存)
};

// CSV 列名
const COLUMNS = {
  ip: "IP地址",
  port: "端口号",
  speed: "下载速度",
  datacenter: "数据中心",
  bronIpLocatie: "源IP位置",
  outbound: "出站IP", // 这是需要判断的列
};

class CSVProcessor {
  constructor(config = CONFIG) {
    this.config = config;
    this.locations = null;
    this.scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
  }

  async process() {
    try {
      const csvFilePath = this.getFilePath(this.config.targetFile);
      const txtUnlimitedFilePath = this.getFilePath(
        this.config.targetFile.replace(".csv", "_unlimited.txt"),
      );
      const txtLimitedFilePath = this.getFilePath(
        this.config.targetFile.replace(".csv", "_limited.txt"),
      );

      await this.validateFileExists(csvFilePath);
      console.log(`开始处理文件: ${this.config.targetFile}`);
      console.log(`出站IP过滤模式: ${this.getOutboundTypeText()}`);

      await this.loadLocations();
      await this.processCSV(
        csvFilePath,
        txtUnlimitedFilePath,
        txtLimitedFilePath,
      );
    } catch (error) {
      this.handleError("处理文件时发生错误", error);
    }
  }

  getOutboundTypeText() {
    switch (this.config.outboundType) {
      case "ipv4":
        return "只保存IPv4";
      case "ipv6":
        return "只保存IPv6";
      case "all":
        return "保存所有类型";
      default:
        return "未知配置";
    }
  }

  getFilePath(filename) {
    return path.resolve(this.scriptDir, filename);
  }

  async validateFileExists(filePath) {
    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`未找到指定的文件: ${path.basename(filePath)}`);
    }
  }

  async loadLocations() {
    try {
      const jsonFilePath = this.getFilePath("locations.json");
      const jsonData = await fs.readFile(jsonFilePath, "utf8");
      this.locations = JSON.parse(jsonData);
      console.log("位置数据加载成功。");
    } catch (error) {
      throw new Error(`加载位置数据失败: ${error.message}`);
    }
  }

  isIPv4(ip) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
  }

  isIPv6(ip) {
    return ip.includes(":") && !this.isIPv4(ip);
  }

  // 从可能的IP:端口#国家格式中提取纯IP
  extractPureIp(ipField) {
    if (!ipField) return "";

    let pureIp = ipField.trim();

    // 如果包含#国家，移除
    if (pureIp.includes("#")) {
      pureIp = pureIp.split("#")[0];
    }

    // 如果包含端口（最后一个冒号后面是数字），移除端口
    if (pureIp.includes(":")) {
      const lastColonIndex = pureIp.lastIndexOf(":");
      const afterLastColon = pureIp.substring(lastColonIndex + 1);
      if (/^\d+$/.test(afterLastColon)) {
        pureIp = pureIp.substring(0, lastColonIndex);
      }
    }

    return pureIp;
  }

  shouldIncludeByOutboundType(outboundIp) {
    const pureIp = this.extractPureIp(outboundIp);

    switch (this.config.outboundType) {
      case "ipv4":
        return this.isIPv4(pureIp);
      case "ipv6":
        return this.isIPv6(pureIp);
      case "all":
        return true;
      default:
        return true;
    }
  }

  getCountryFromLocationData(datacenterCode, bronIpLocatie) {
    if (!this.locations) return "Unknown";

    // 优先查找同时匹配 datacenterCode 和 bronIpLocatie 的 location
    const exactMatch = this.locations.find(
      (loc) => loc.iata === datacenterCode && loc.cca2 === bronIpLocatie,
    );

    if (exactMatch) {
      return `${exactMatch.emoji}${exactMatch.country}`;
    }

    // 如果没有精确匹配，则只匹配 bronIpLocatie
    const countryMatch = this.locations.find(
      (loc) => loc.cca2 === bronIpLocatie,
    );
    return countryMatch
      ? `${countryMatch.emoji}${countryMatch.country}`
      : "Unknown";
  }

  parseCSVLine(line) {
    // 简单的CSV解析，处理可能包含逗号的字段
    const result = [];
    let inQuotes = false;
    let currentField = "";

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"' && (i === 0 || line[i - 1] !== "\\")) {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(currentField.trim());
        currentField = "";
      } else {
        currentField += char;
      }
    }

    result.push(currentField.trim());
    return result;
  }

  shouldIncludeBySpeed(speedField) {
    if (!this.config.filterBySpeed || !speedField) return true;

    const speedValue = parseFloat(speedField.replace(" kB/s", ""));
    return !isNaN(speedValue) && speedValue >= this.config.minSpeed;
  }

  async processCSV(csvFilePath, txtUnlimitedFilePath, txtLimitedFilePath) {
    console.log(`开始读取 CSV 文件: ${path.basename(csvFilePath)}`);

    const data = await fs.readFile(csvFilePath, "utf8");
    const lines = data
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      throw new Error("CSV 文件内容不足或格式不正确");
    }

    // 解析表头
    const headers = this.parseCSVLine(lines[0]);
    const indices = this.getColumnIndices(headers);

    // 处理数据行
    const ipEntries = this.processDataLines(lines.slice(1), indices);

    if (ipEntries.length === 0) {
      console.log("没有符合条件的IP记录");
      return;
    }

    // 分组处理
    const groupedEntries = this.groupEntriesByCountry(ipEntries);

    if (Object.keys(groupedEntries).length === 0) {
      console.log("没有国家满足数量要求");
      return;
    }

    // 生成并保存两个版本的结果
    await this.generateAndSaveResults(
      groupedEntries,
      txtUnlimitedFilePath,
      txtLimitedFilePath,
    );
  }

  getColumnIndices(headers) {
    const indices = {};
    const requiredColumns = [
      COLUMNS.ip,
      COLUMNS.port,
      COLUMNS.datacenter,
      COLUMNS.bronIpLocatie,
    ];

    for (const col of requiredColumns) {
      indices[col] = headers.indexOf(col);
      if (indices[col] === -1) {
        throw new Error(`CSV 文件缺少 ${col} 列`);
      }
    }

    // 速度列是可选的
    indices[COLUMNS.speed] = headers.indexOf(COLUMNS.speed);

    // 出站IP列是可选的（用于过滤）
    indices[COLUMNS.outbound] = headers.indexOf(COLUMNS.outbound);

    return indices;
  }

  processDataLines(lines, indices) {
    const ipEntries = [];
    let ipv4Count = 0;
    let ipv6Count = 0;
    let filteredByOutboundType = 0;
    let noOutboundIpCount = 0;

    for (const line of lines) {
      if (!line) continue;

      const fields = this.parseCSVLine(line);
      if (
        fields.length <=
        Math.max(...Object.values(indices).filter((i) => i !== -1))
      ) {
        continue; // 跳过列数不足的行
      }

      // 获取出站IP用于类型判断
      let outboundIp = null;
      if (
        indices[COLUMNS.outbound] !== -1 &&
        indices[COLUMNS.outbound] < fields.length
      ) {
        outboundIp = fields[indices[COLUMNS.outbound]].trim();
      }

      // 统计IP类型（使用出站IP）
      if (outboundIp) {
        const pureOutboundIp = this.extractPureIp(outboundIp);
        if (this.isIPv4(pureOutboundIp)) {
          ipv4Count++;
        } else if (this.isIPv6(pureOutboundIp)) {
          ipv6Count++;
        }

        // 出站IP类型过滤
        if (!this.shouldIncludeByOutboundType(outboundIp)) {
          filteredByOutboundType++;
          continue;
        }
      } else {
        noOutboundIpCount++;
        // 如果没有出站IP，根据配置决定是否保留
        if (this.config.outboundType !== "all") {
          filteredByOutboundType++;
          continue;
        }
      }

      // 速度过滤
      if (
        indices[COLUMNS.speed] !== -1 &&
        !this.shouldIncludeBySpeed(fields[indices[COLUMNS.speed]])
      ) {
        continue;
      }

      // 提取IP地址和端口（用于输出）
      const ip = fields[indices[COLUMNS.ip]].trim();
      const port = fields[indices[COLUMNS.port]];
      const datacenter = fields[indices[COLUMNS.datacenter]];
      const bronIpLocatie = fields[indices[COLUMNS.bronIpLocatie]];

      const country = this.getCountryFromLocationData(
        datacenter,
        bronIpLocatie,
      );

      ipEntries.push({
        entry: `${ip}:${port}#${country}`,
        country,
      });
    }

    console.log(`出站IP类型统计:`);
    console.log(`  - IPv4: ${ipv4Count} 条`);
    console.log(`  - IPv6: ${ipv6Count} 条`);
    console.log(`  - 无出站IP: ${noOutboundIpCount} 条`);

    if (this.config.outboundType !== "all") {
      console.log(`  - 根据配置过滤: ${filteredByOutboundType} 条`);
    }

    console.log(
      `IP 和端口提取完成。共 ${ipEntries.length} 条记录 (已应用过滤)`,
    );
    return ipEntries;
  }

  groupEntriesByCountry(ipEntries) {
    const grouped = {};

    for (const { entry, country } of ipEntries) {
      if (!grouped[country]) {
        grouped[country] = [];
      }
      grouped[country].push(entry);
    }

    return grouped;
  }

  filterCountriesByMinCount(groupedEntries) {
    const minCount =
      this.config.perCountryCount > 0 ? this.config.perCountryCount : 1;
    return Object.fromEntries(
      Object.entries(groupedEntries).filter(
        ([country, entries]) => entries.length >= minCount,
      ),
    );
  }

  formatEntriesWithIndex(entries, startIndex = 1) {
    return entries.map((entry, index) => `${entry}${startIndex + index}`);
  }

  async generateAndSaveResults(
    groupedEntries,
    txtUnlimitedFilePath,
    txtLimitedFilePath,
  ) {
    const filteredEntries = this.filterCountriesByMinCount(groupedEntries);
    const filteredCountries = Object.keys(filteredEntries).sort();

    if (filteredCountries.length === 0) {
      const message = `没有国家满足最小记录数要求 (${this.config.perCountryCount} 条)`;
      console.log(message);

      await Promise.all([
        fs.writeFile(txtUnlimitedFilePath, "", "utf8"),
        fs.writeFile(txtLimitedFilePath, "", "utf8"),
      ]);

      console.log(
        `不限制数量版本: ${path.basename(txtUnlimitedFilePath)} (空文件)`,
      );
      console.log(
        `限制数量版本: ${path.basename(txtLimitedFilePath)} (空文件)`,
      );
      return;
    }

    const allCountries = Object.keys(groupedEntries).sort();

    console.log(
      `所有国家: ${allCountries.join("、")} (共 ${allCountries.length} 个国家)`,
    );
    console.log(
      `符合条件国家 (记录数 >= ${this.config.perCountryCount}): ${filteredCountries.join("、")} (共 ${filteredCountries.length} 个国家)`,
    );

    const unlimitedResult = filteredCountries
      .map((country) =>
        this.formatEntriesWithIndex(filteredEntries[country], 1).join("\n"),
      )
      .join("\n");

    const limitedResult = filteredCountries
      .map((country) =>
        this.formatEntriesWithIndex(
          filteredEntries[country].slice(0, this.config.perCountryCount),
          1,
        ).join("\n"),
      )
      .join("\n");

    await Promise.all([
      fs.writeFile(txtUnlimitedFilePath, unlimitedResult, "utf8"),
      fs.writeFile(txtLimitedFilePath, limitedResult, "utf8"),
    ]);

    const unlimitedCount = unlimitedResult
      .split("\n")
      .filter((line) => line.trim()).length;
    const limitedCount = limitedResult
      .split("\n")
      .filter((line) => line.trim()).length;

    console.log(`\n不限制数量版本: ${path.basename(txtUnlimitedFilePath)}`);
    console.log(`  - 包含国家: ${filteredCountries.length} 个`);
    console.log(`  - 总记录数: ${unlimitedCount} 条`);

    console.log(`\n限制数量版本: ${path.basename(txtLimitedFilePath)}`);
    console.log(`  - 包含国家: ${filteredCountries.length} 个`);
    console.log(`  - 总记录数: ${limitedCount} 条`);
    console.log(`  - 每个国家最多提取: ${this.config.perCountryCount} 条`);

    const excludedCountries = allCountries.filter(
      (country) => !filteredCountries.includes(country),
    );
    if (excludedCountries.length > 0) {
      console.log(`\n排除的国家 (记录数 < ${this.config.perCountryCount}):`);
      excludedCountries.forEach((country) => {
        console.log(
          `  ❌ ${country}: ${groupedEntries[country].length} 条记录`,
        );
      });
    }
  }

  handleError(context, error) {
    console.error(`${context}: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

// 执行处理
async function main() {
  const args = process.argv.slice(2);
  const config = { ...CONFIG };

  for (const arg of args) {
    if (arg.startsWith("--outbound=")) {
      const value = arg.split("=")[1];
      if (["ipv4", "ipv6", "all"].includes(value)) {
        config.outboundType = value;
        console.log(`通过命令行参数设置: 出站IP过滤模式 = ${value}`);
      }
    }
  }

  const processor = new CSVProcessor(config);
  await processor.process();
}

// 启动应用
main().catch((error) => {
  console.error("应用程序执行失败:", error.message);
  process.exit(1);
});
