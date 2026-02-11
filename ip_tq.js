import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

// 配置参数
const CONFIG = {
  perCountryCount: 5, // 每个国家最小记录数，小于此数量的国家不提取
  filterBySpeed: true, // 是否过滤下载速度
  minSpeed: 100, // 过滤下载速度下限，单位kb/s
  targetFile: "ip_tq.csv", // 指定要处理的CSV文件名
};

// CSV 列名
const COLUMNS = {
  ip: "IP地址",
  port: "端口",
  speed: "下载速度",
  datacenter: "数据中心",
  bronIpLocatie: "源IP位置",
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

  isIPv6(ip) {
    return ip.includes(":");
  }

  formatIPv6(ip) {
    return this.isIPv6(ip) && !ip.startsWith("[") ? `[${ip}]` : ip;
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

    return indices;
  }

  processDataLines(lines, indices) {
    const ipEntries = [];

    for (const line of lines) {
      if (!line) continue;

      const fields = this.parseCSVLine(line);
      if (
        fields.length <=
        Math.max(...Object.values(indices).filter((i) => i !== -1))
      ) {
        continue; // 跳过列数不足的行
      }

      // 速度过滤
      if (
        indices[COLUMNS.speed] !== -1 &&
        !this.shouldIncludeBySpeed(fields[indices[COLUMNS.speed]])
      ) {
        continue;
      }

      // 提取和格式化数据
      const ip = this.formatIPv6(fields[indices[COLUMNS.ip]]);
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

    console.log(`IP 和端口提取完成。共 ${ipEntries.length} 条记录`);
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
    // 只保留记录数量 >= perCountryCount 的国家
    // 如果 perCountryCount 为 0，则保留所有国家（至少1条）
    const minCount =
      this.config.perCountryCount > 0 ? this.config.perCountryCount : 1;
    return Object.fromEntries(
      Object.entries(groupedEntries).filter(
        ([country, entries]) => entries.length >= minCount,
      ),
    );
  }

  formatEntriesWithIndex(entries, startIndex = 1) {
    // 为每个国家的IP地址添加序号
    return entries.map((entry, index) => `${entry}${startIndex + index}`);
  }

  async generateAndSaveResults(
    groupedEntries,
    txtUnlimitedFilePath,
    txtLimitedFilePath,
  ) {
    // 第一步：过滤掉记录数小于 perCountryCount 的国家
    const filteredEntries = this.filterCountriesByMinCount(groupedEntries);
    const filteredCountries = Object.keys(filteredEntries).sort();

    if (filteredCountries.length === 0) {
      const message = `没有国家满足最小记录数要求 (${this.config.perCountryCount} 条)`;
      console.log(message);

      // 创建两个空文件
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

    // 1. 生成不限制数量的版本（但只包含符合条件国家的所有记录，每个国家独立添加序号）
    const unlimitedResult = filteredCountries
      .map((country) =>
        this.formatEntriesWithIndex(filteredEntries[country], 1).join("\n"),
      )
      .join("\n");

    // 2. 生成限制数量的版本（只提取符合条件国家的前 perCountryCount 条记录，每个国家独立添加序号）
    const limitedResult = filteredCountries
      .map((country) =>
        this.formatEntriesWithIndex(
          filteredEntries[country].slice(0, this.config.perCountryCount),
          1,
        ).join("\n"),
      )
      .join("\n");

    // 同时保存两个文件
    await Promise.all([
      fs.writeFile(txtUnlimitedFilePath, unlimitedResult, "utf8"),
      fs.writeFile(txtLimitedFilePath, limitedResult, "utf8"),
    ]);

    // 统计信息
    const unlimitedCount = unlimitedResult
      .split("\n")
      .filter((line) => line.trim()).length;
    const limitedCount = limitedResult
      .split("\n")
      .filter((line) => line.trim()).length;

    console.log(`\n不限制数量版本: ${path.basename(txtUnlimitedFilePath)}`);
    console.log(`  - 包含国家: ${filteredCountries.length} 个`);
    console.log(`  - 总记录数: ${unlimitedCount} 条`);
    console.log(`  - 文件格式: IP:端口#国家名称序号`);

    console.log(`\n限制数量版本: ${path.basename(txtLimitedFilePath)}`);
    console.log(`  - 包含国家: ${filteredCountries.length} 个`);
    console.log(`  - 总记录数: ${limitedCount} 条`);
    console.log(`  - 每个国家最多提取: ${this.config.perCountryCount} 条`);
    console.log(`  - 文件格式: IP:端口#国家名称序号`);

    // 显示被排除的国家
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
  const processor = new CSVProcessor();
  await processor.process();
}

// 启动应用
main().catch((error) => {
  console.error("应用程序执行失败:", error.message);
  process.exit(1);
});
