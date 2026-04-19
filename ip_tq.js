import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

// 配置参数
const CONFIG = {
    perCountryCount: 5, // 每个国家最小记录数，小于此数量的国家不提取
    filterBySpeed: true, // 是否过滤下载速度
    minSpeed: 100, // 过滤下载速度下限，单位kb/s
    targetFile: 'ip_tq.csv', // 指定要处理的CSV文件名
    outboundType: 'all', // 出站IP类型: 'ipv4' (只保存IPv4), 'ipv6' (只保存IPv6), 'all' (都保存)
};

// CSV 列名
const COLUMNS = {
    ip: 'IP地址',
    port: '端口号',
    speed: '下载速度',
    datacenter: '数据中心',
    bronIpLocatie: 'IP位置',
    outboundtype: '出站IP类型',
    asnOrg: 'ASN号码',
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
            const txtUnlimitedFilePath = this.getFilePath('ip_all.txt');
            const txtLimitedFilePath = this.getFilePath('ip_top5.txt');

            await this.validateFileExists(csvFilePath);
            console.log(`开始处理文件: ${this.config.targetFile}`);
            console.log(`出站IP过滤模式: ${this.getOutboundTypeText()}`);

            await this.loadLocations();
            await this.processCSV(csvFilePath, txtUnlimitedFilePath, txtLimitedFilePath);
        } catch (error) {
            this.handleError('处理文件时发生错误', error);
        }
    }

    getOutboundTypeText() {
        switch (this.config.outboundType) {
            case 'ipv4':
                return '只保存IPv4';
            case 'ipv6':
                return '只保存IPv6';
            case 'all':
                return '保存所有类型';
            default:
                return '未知配置';
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
            const jsonFilePath = this.getFilePath('locations.json');
            const jsonData = await fs.readFile(jsonFilePath, 'utf8');
            this.locations = JSON.parse(jsonData);
            console.log('位置数据加载成功。');
        } catch (error) {
            throw new Error(`加载位置数据失败: ${error.message}`);
        }
    }

    // 直接根据字段值判断是否包含
    shouldIncludeByOutboundType(typeValue) {
        if (!typeValue) {
            // 如果没有类型值，根据配置决定
            return this.config.outboundType === 'all';
        }

        switch (this.config.outboundType) {
            case 'ipv4':
                return typeValue === 'IPv4';
            case 'ipv6':
                return typeValue === 'IPv6';
            case 'all':
                return true;
            default:
                return true;
        }
    }

    getCountryFromLocationData(datacenterCode, bronIpLocatie) {
        if (!this.locations) return 'Unknown';

        // 优先查找同时匹配 datacenterCode 和 bronIpLocatie 的 location
        const exactMatch = this.locations.find((loc) => loc.iata === datacenterCode && loc.cca2 === bronIpLocatie);

        if (exactMatch) {
            return `${exactMatch.emoji}${exactMatch.country}`;
        }

        // 如果没有精确匹配，则只匹配 bronIpLocatie
        const countryMatch = this.locations.find((loc) => loc.cca2 === bronIpLocatie);
        return countryMatch ? `${countryMatch.emoji}${countryMatch.country}` : 'Unknown';
    }

    parseCSVLine(line) {
        // 简单的CSV解析，处理可能包含逗号的字段
        const result = [];
        let inQuotes = false;
        let currentField = '';

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(currentField.trim());
                currentField = '';
            } else {
                currentField += char;
            }
        }

        result.push(currentField.trim());
        return result;
    }

    shouldIncludeBySpeed(speedField) {
        if (!this.config.filterBySpeed || !speedField) return true;

        const speedValue = parseFloat(speedField.replace(' kB/s', ''));
        return !isNaN(speedValue) && speedValue >= this.config.minSpeed;
    }

    async processCSV(csvFilePath, txtUnlimitedFilePath, txtLimitedFilePath) {
        console.log(`开始读取 CSV 文件: ${path.basename(csvFilePath)}`);

        const data = await fs.readFile(csvFilePath, 'utf8');
        const lines = data
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        if (lines.length < 2) {
            throw new Error('CSV 文件内容不足或格式不正确');
        }

        // 解析表头
        const headers = this.parseCSVLine(lines[0]);
        const indices = this.getColumnIndices(headers);

        // 处理数据行 - 同时生成两种结果
        const { ipEntries, filteredIpPortList } = this.processDataLines(lines.slice(1), indices);

        // 分组处理（按国家）- 用于保存的文件
        const groupedEntries = this.groupEntriesByCountry(ipEntries);

        if (Object.keys(groupedEntries).length === 0) {
            console.log('没有国家满足数量要求');
            return;
        }

        // 生成并保存两个版本的结果（不使用ASN组织过滤）
        await this.generateAndSaveResults(groupedEntries, txtUnlimitedFilePath, txtLimitedFilePath);
    }

    getColumnIndices(headers) {
        const indices = {};
        const requiredColumns = [COLUMNS.ip, COLUMNS.port, COLUMNS.datacenter, COLUMNS.bronIpLocatie];

        for (const col of requiredColumns) {
            indices[col] = headers.indexOf(col);
            if (indices[col] === -1) {
                throw new Error(`CSV 文件缺少 ${col} 列`);
            }
        }

        // 速度列是可选的
        indices[COLUMNS.speed] = headers.indexOf(COLUMNS.speed);

        // 出站IP类型列是可选的（用于过滤）
        indices[COLUMNS.outboundtype] = headers.indexOf(COLUMNS.outboundtype);

        // ASN组织列是可选的（仅用于日志输出）
        indices[COLUMNS.asnOrg] = headers.indexOf(COLUMNS.asnOrg);

        return indices;
    }

    processDataLines(lines, indices) {
        const ipEntries = []; // 用于保存文件（不使用ASN组织过滤）
        const filteredIpPortList = []; // 用于日志输出（使用ASN组织过滤，且只包含IPv4）

        let ipv4Count = 0;
        let ipv6Count = 0;
        let filteredByOutboundType = 0;
        let noOutboundIpCount = 0;

        // 用于统计每个ASN组织的匹配数量（仅用于日志输出）
        const asnOrgStats = {};

        for (const line of lines) {
            if (!line) continue;

            const fields = this.parseCSVLine(line);
            if (fields.length <= Math.max(...Object.values(indices).filter((i) => i !== -1))) {
                continue; // 跳过列数不足的行
            }
            // 获取出站IP类型
            let outboundType = null;
            if (indices[COLUMNS.outboundtype] !== -1 && indices[COLUMNS.outboundtype] < fields.length) {
                outboundType = fields[indices[COLUMNS.outboundtype]].trim();
            }

            // 统计IP类型
            if (outboundType) {
                if (outboundType === 'IPv4') {
                    ipv4Count++;
                } else if (outboundType === 'IPv6') {
                    ipv6Count++;
                }

                // 出站IP类型过滤（用于保存文件）
                if (!this.shouldIncludeByOutboundType(outboundType)) {
                    filteredByOutboundType++;
                    continue;
                }
            } else {
                noOutboundIpCount++;
                // 如果没有出站IP，根据配置决定是否保留（用于保存文件）
                if (this.config.outboundType !== 'all') {
                    filteredByOutboundType++;
                    continue;
                }
            }

            // 速度过滤（用于保存文件）
            if (indices[COLUMNS.speed] !== -1 && !this.shouldIncludeBySpeed(fields[indices[COLUMNS.speed]])) {
                continue;
            }

            // 提取IP地址和端口
            const ip = fields[indices[COLUMNS.ip]].trim();
            const port = fields[indices[COLUMNS.port]];

            // 获取国家信息用于分组（用于保存文件）
            const datacenter = fields[indices[COLUMNS.datacenter]];
            const bronIpLocatie = fields[indices[COLUMNS.bronIpLocatie]];
            const country = this.getCountryFromLocationData(datacenter, bronIpLocatie);

            // 添加到保存文件列表（所有记录，不分ASN组织）
            ipEntries.push({
                entry: `${ip}:${port}#${country}`,
                country,
            });
        }

        console.log(`\n出站IP类型统计 (用于保存文件):`);
        console.log(`  - IPv4: ${ipv4Count} 条`);
        console.log(`  - IPv6: ${ipv6Count} 条`);
        console.log(`  - 无出站IP: ${noOutboundIpCount} 条`);

        if (this.config.outboundType !== 'all') {
            console.log(`  - 根据配置过滤: ${filteredByOutboundType} 条`);
        }

        console.log(`\nIP 和端口提取完成。共 ${ipEntries.length} 条记录 (用于保存文件)`);

        return { ipEntries, filteredIpPortList };
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
        const minCount = this.config.perCountryCount > 0 ? this.config.perCountryCount : 1;
        return Object.fromEntries(Object.entries(groupedEntries).filter(([country, entries]) => entries.length >= minCount));
    }

    formatEntriesWithIndex(entries, startIndex = 1) {
        return entries.map((entry, index) => `${entry}${startIndex + index}`);
    }

    async generateAndSaveResults(groupedEntries, txtUnlimitedFilePath, txtLimitedFilePath) {
        const filteredEntries = this.filterCountriesByMinCount(groupedEntries);
        const filteredCountries = Object.keys(filteredEntries).sort();

        if (filteredCountries.length === 0) {
            const message = `没有国家满足最小记录数要求 (${this.config.perCountryCount} 条)`;
            console.log(message);

            await Promise.all([fs.writeFile(txtUnlimitedFilePath, '', 'utf8'), fs.writeFile(txtLimitedFilePath, '', 'utf8')]);

            console.log(`不限制数量版本: ${path.basename(txtUnlimitedFilePath)} (空文件)`);
            console.log(`限制数量版本: ${path.basename(txtLimitedFilePath)} (空文件)`);
            return;
        }

        const allCountries = Object.keys(groupedEntries).sort();

        console.log(`\n所有国家 (用于保存文件): ${allCountries.join('、')} (共 ${allCountries.length} 个国家)`);
        console.log(
            `符合条件国家 (记录数 >= ${this.config.perCountryCount}): ${filteredCountries.join('、')} (共 ${filteredCountries.length} 个国家)`
        );

        const unlimitedResult = filteredCountries.map((country) => this.formatEntriesWithIndex(filteredEntries[country], 1).join('\n')).join('\n');

        const limitedResult = filteredCountries
            .map((country) => this.formatEntriesWithIndex(filteredEntries[country].slice(0, this.config.perCountryCount), 1).join('\n'))
            .join('\n');

        await Promise.all([fs.writeFile(txtUnlimitedFilePath, unlimitedResult, 'utf8'), fs.writeFile(txtLimitedFilePath, limitedResult, 'utf8')]);

        const unlimitedCount = unlimitedResult.split('\n').filter((line) => line.trim()).length;
        const limitedCount = limitedResult.split('\n').filter((line) => line.trim()).length;

        console.log(`\n不限制数量版本: ${path.basename(txtUnlimitedFilePath)}`);
        console.log(`  - 包含国家: ${filteredCountries.length} 个`);
        console.log(`  - 总记录数: ${unlimitedCount} 条`);

        console.log(`\n限制数量版本: ${path.basename(txtLimitedFilePath)}`);
        console.log(`  - 包含国家: ${filteredCountries.length} 个`);
        console.log(`  - 总记录数: ${limitedCount} 条`);
        console.log(`  - 每个国家最多提取: ${this.config.perCountryCount} 条`);

        const excludedCountries = allCountries.filter((country) => !filteredCountries.includes(country));
        if (excludedCountries.length > 0) {
            console.log(`\n排除的国家 (记录数 < ${this.config.perCountryCount}):`);
            excludedCountries.forEach((country) => {
                console.log(`  ❌ ${country}: ${groupedEntries[country].length} 条记录`);
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
        if (arg.startsWith('--outbound=')) {
            const value = arg.split('=')[1];
            if (['ipv4', 'ipv6', 'all'].includes(value)) {
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
    console.error('应用程序执行失败:', error.message);
    process.exit(1);
});