
import fs from 'fs';
import net from 'net';
import tls from 'tls';
import http from 'http';
import https from 'https';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置常量
const REQUEST_URL = 'speed.cloudflare.com/cdn-cgi/trace';
const TIMEOUT = 1000; // 1秒
const MAX_DURATION = 2000; // 2秒

// 命令行参数
const options = {
    file: '../init.csv',
    outfile: 'ip.csv',
    maxThreads: 100,
    speedtest: 5,
    url: 'speed.cloudflare.com/__down?bytes=500000000',
    tls: true,
    delay: 0
};

// 全局变量
let locations = [];
let locationMap = new Map();
let validCount = 0;
let startTime = Date.now();

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '-file':
            case '--file':
                options.file = args[++i];
                break;
            case '-outfile':
            case '--outfile':
                options.outfile = args[++i];
                break;
            case '-max':
            case '--max':
                options.maxThreads = parseInt(args[++i]);
                break;
            case '-speedtest':
            case '--speedtest':
                options.speedtest = parseInt(args[++i]);
                break;
            case '-url':
            case '--url':
                options.url = args[++i];
                break;
            case '-tls':
            case '--tls':
                options.tls = args[++i] !== 'false';
                break;
            case '-delay':
            case '--delay':
                options.delay = parseInt(args[++i]);
                break;
        }
    }
}

// HTTP GET 请求
async function httpGet(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const req = protocol.get(url, { signal: controller.signal }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                clearTimeout(timeoutId);
                resolve(data);
            });
        });
        
        req.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}

// 加载位置信息
async function loadLocations() {
    try {
        const locationsPath = join(__dirname, 'locations.json');
        
        if (fs.existsSync(locationsPath)) {
            console.log('本地 locations.json 已存在，无需重新下载');
            const data = await fs.promises.readFile(locationsPath, 'utf8');
            locations = JSON.parse(data);
        } else {
            console.log('本地 locations.json 不存在\n正在从 https://locations-adw.pages.dev/ 下载 locations.json');
            const response = await httpGet('https://locations-adw.pages.dev/');
            locations = JSON.parse(response);
            await fs.promises.writeFile(locationsPath, response);
        }

        for (const loc of locations) {
            locationMap.set(loc.iata, loc);
        }
    } catch (err) {
        console.error('加载位置信息失败:', err.message);
        process.exit(1);
    }
}

// 读取IP列表
async function readIPs(filename) {
    const filePath = join(__dirname, filename);
    
    if (!fs.existsSync(filePath)) {
        throw new Error(`文件 ${filename} 不存在`);
    }

    const ips = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let isFirstLine = true;
    let ipColIndex = -1;
    let portColIndex = -1;

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 解析 CSV 行
        const values = parseCSVLine(trimmed);
        
        // 处理表头
        if (isFirstLine) {
            isFirstLine = false;
            // 查找 IP 和 port 列
            for (let i = 0; i < values.length; i++) {
                const header = values[i].toLowerCase().trim();
                if (header.includes('ip') || header === 'ip地址' || header === 'address') {
                    ipColIndex = i;
                }
                if (header.includes('port') || header === '端口' || header === '端口号') {
                    portColIndex = i;
                }
            }
            
            if (ipColIndex === -1 || portColIndex === -1) {
                throw new Error('CSV文件中未找到IP或端口列');
            }
            continue;
        }

        // 读取数据行
        if (values.length > Math.max(ipColIndex, portColIndex)) {
            const ip = values[ipColIndex].trim();
            const portStr = values[portColIndex].trim();
            
            if (!ip || !portStr) continue;

            const port = parseInt(portStr);
            if (isNaN(port) || port < 1 || port > 65535) {
                console.log(`端口格式错误: ${portStr}`);
                continue;
            }

            ips.push({ ip, port });
        }
    }

    return ips;
}

// CSV 行解析函数（处理引号和逗号）
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                // 转义的引号
                current += '"';
                i++;
            } else {
                // 切换引号状态
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // 逗号分隔符
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    // 添加最后一个值
    values.push(current);
    
    return values;
}

// 测试单个IP
async function testSingleIP(ip, port) {
    return new Promise((resolve) => {
        const start = Date.now();
        let timeoutId;

        const socket = new net.Socket();
        
        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            socket.removeAllListeners();
            socket.destroy();
        };

        timeoutId = setTimeout(() => {
            cleanup();
            resolve(null);
        }, TIMEOUT);

        socket.setTimeout(TIMEOUT);
        
        socket.on('connect', async () => {
            const tcpDuration = Date.now() - start;
            
            // 延迟过滤
            if (options.delay > 0 && tcpDuration > options.delay) {
                cleanup();
                resolve(null);
                return;
            }

            try {
                const result = await makeHTTPRequest(socket, ip, port, tcpDuration);
                cleanup();
                resolve(result);
            } catch (err) {
                cleanup();
                resolve(null);
            }
        });

        socket.on('error', () => {
            cleanup();
            resolve(null);
        });

        socket.on('timeout', () => {
            cleanup();
            resolve(null);
        });

        socket.connect(port, ip);
    });
}
function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
// 发送HTTP请求
function makeHTTPRequest(socket, ip, port, tcpDuration) {
    return new Promise((resolve, reject) => {
        const protocol = options.tls ? 'https' : 'http';
        const requestURL = `${protocol}://${REQUEST_URL}`;
        
        const parsedUrl = new URL(requestURL);
        const headers = {
            'Host': parsedUrl.host,
            'User-Agent': 'Mozilla/5.0',
            'Connection': 'close'
        };

        const requestOptions = {
            method: 'GET',
            path: parsedUrl.pathname + parsedUrl.search,
            headers: headers
        };

        let client;
        if (options.tls) {
            client = tls.connect({
                socket: socket,
                servername: parsedUrl.hostname,
                host: parsedUrl.hostname,
                port: parsedUrl.port || 443
            });
        } else {
            client = socket;
        }

        let responseData = '';
        let timeoutId = setTimeout(() => {
            client.destroy();
            reject(new Error('Request timeout'));
        }, MAX_DURATION);

        client.on('data', (chunk) => {
            responseData += chunk.toString();
        });

        client.on('end', () => {
            clearTimeout(timeoutId);
            
            // 解析响应
            if (responseData.includes('uag=Mozilla/5.0')) {
                const coloMatch = responseData.match(/colo=([A-Z]+)/);
                const locMatch = responseData.match(/loc=([A-Z]+)/);
                
                if (coloMatch && locMatch) {
                    const dataCenter = coloMatch[1];
                    const locCode = locMatch[1];
                    
                    // 解析所有字段
                    const parsedData = parseTraceResponse(responseData);
                    
                    const loc = locationMap.get(dataCenter);
                    
                    const outboundIP = parsedData.ip || '';
                    const ipType = getIPType(outboundIP);
                    let formattedTimestamp = '';
                    if (parsedData.ts) {
                        const timestamp = parseInt(parsedData.ts);
                        if (!isNaN(timestamp)) {
                            // 判断是秒级还是毫秒级时间戳
                            const date = timestamp > 10000000000 
                                ? new Date(timestamp) // 毫秒级时间戳
                                : new Date(timestamp * 1000); // 秒级时间戳
                            formattedTimestamp = formatTimestamp(date);
                        } else {
                            formattedTimestamp = parsedData.ts; // 如果不是数字，保留原值
                        }
                    }
                    const result = {
                        ip,
                        port,
                        dataCenter,
                        locCode,
                        latency: `${tcpDuration} ms`,
                        tcpDuration,
                        outboundIP,
                        ipType,
                        visitScheme: parsedData.visit_scheme || '',
                        tlsVersion: parsedData.tls || '',
                        sni: parsedData.sni || '',
                        httpVersion: parsedData.http || '',
                        warp: parsedData.warp || '',
                        gateway: parsedData.gateway || '',
                        rbi: parsedData.rbi || '',
                        kex: parsedData.kex || '',
                        timestamp: formattedTimestamp || '',
                        region: loc?.region || '',
                        city: loc?.city || '',
                        region_zh: loc?.region_zh || '',
                        country: loc?.country || '',
                        city_zh: loc?.city_zh || '',
                        emoji: loc?.emoji || ''
                    };
                    
                    console.log(`\n发现有效IP ${ip} 端口 ${port} 位置信息 ${result.city_zh} 出站IP ${outboundIP} (${ipType}) 延迟 ${tcpDuration} 毫秒`);
                    resolve(result);
                } else {
                    reject(new Error('Invalid response format'));
                }
            } else {
                reject(new Error('Unexpected response'));
            }
        });

        client.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });

        // 发送请求
        const requestLine = `GET ${requestOptions.path} HTTP/1.1\r\n`;
        const headerLines = Object.entries(requestOptions.headers)
            .map(([k, v]) => `${k}: ${v}\r\n`).join('');
        const request = requestLine + headerLines + '\r\n';
        
        client.write(request);
    });
}

// 解析响应
function parseTraceResponse(body) {
    const result = {};
    const lines = body.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            result[key] = value;
        }
    }
    
    return result;
}

// 获取IP类型
function getIPType(ip) {
    if (!ip) return '未知';
    
    if (net.isIPv4(ip)) return 'IPv4';
    if (net.isIPv6(ip)) return 'IPv6';
    return '无效IP';
}

// 测试IP列表
async function testIPs(ips) {
    const results = [];
    const queue = [...ips];
    const activePromises = new Set();
    let completed = 0;
    const total = ips.length;

    return new Promise((resolve) => {
        function next() {
            while (activePromises.size < options.maxThreads && queue.length > 0) {
                const item = queue.shift();
                const promise = testSingleIP(item.ip, item.port).then(result => {
                    if (result) {
                        results.push(result);
                        validCount++;
                    }
                    activePromises.delete(promise);
                    completed++;
                    const percentage = (completed / total * 100).toFixed(2);
                    process.stdout.write(`\r已完成: ${completed} 总数: ${total} 已完成: ${percentage}%`);
                    
                    if (completed === total) {
                        console.log(`\n已完成: ${completed} 总数: ${total} 已完成: 100.00%`);
                    }
                    
                    next();
                });
                activePromises.add(promise);
            }

            if (completed === total && activePromises.size === 0) {
                resolve(results);
            }
        }

        next();
    });
}

// 获取下载速度
async function getDownloadSpeed(ip, port) {
    return new Promise((resolve) => {
        const protocol = options.tls ? 'https' : 'http';
        const url = `${protocol}://${options.url}`;
        const parsedUrl = new URL(url);
        
        console.log(`正在测试IP ${ip} 端口 ${port}`);
        
        const startTime = Date.now();
        let downloadedBytes = 0;
        let isCompleted = false;
        
        const socket = new net.Socket();
        let client;
        let speedTestTimer;

        const cleanup = () => {
            if (speedTestTimer) clearTimeout(speedTestTimer);
            if (client) {
                client.removeAllListeners();
                client.destroy();
            }
            socket.removeAllListeners();
            socket.destroy();
        };

        socket.connect(port, ip, () => {
            if (options.tls) {
                client = tls.connect({
                    socket: socket,
                    servername: parsedUrl.hostname,
                    host: parsedUrl.hostname,
                    port: parsedUrl.port || 443
                });
            } else {
                client = socket;
            }

            const headers = {
                'Host': parsedUrl.host,
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://speed.cloudflare.com/',
                'Connection': 'close'
            };

            const requestLine = `GET ${parsedUrl.pathname + parsedUrl.search} HTTP/1.1\r\n`;
            const headerLines = Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}\r\n`).join('');
            const request = requestLine + headerLines + '\r\n';

            // 设置5秒测速超时
            speedTestTimer = setTimeout(() => {
                if (!isCompleted) {
                    isCompleted = true;
                    const duration = (Date.now() - startTime) / 1000;
                    const speed = (downloadedBytes / duration) / 1024;
                    
                    console.log(`IP ${ip} 端口 ${port} 测速超时，速度 ${speed.toFixed(0)} kB/s`);
                    cleanup();
                    resolve(speed);
                }
            }, 5000);

            client.on('data', (chunk) => {
                if (!isCompleted) {
                    downloadedBytes += chunk.length;
                }
            });

            client.on('end', () => {
                if (!isCompleted) {
                    isCompleted = true;
                    clearTimeout(speedTestTimer);
                    const duration = (Date.now() - startTime) / 1000;
                    const speed = (downloadedBytes / duration) / 1024;
                    
                    console.log(`IP ${ip} 端口 ${port} 下载速度 ${speed.toFixed(0)} kB/s`);
                    cleanup();
                    resolve(speed);
                }
            });

            client.on('error', () => {
                if (!isCompleted) {
                    isCompleted = true;
                    clearTimeout(speedTestTimer);
                    cleanup();
                    resolve(0);
                }
            });

            client.write(request);
        });

        socket.on('error', () => {
            if (!isCompleted) {
                isCompleted = true;
                clearTimeout(speedTestTimer);
                cleanup();
                resolve(0);
            }
        });

        socket.setTimeout(5000);
        socket.on('timeout', () => {
            if (!isCompleted) {
                isCompleted = true;
                clearTimeout(speedTestTimer);
                cleanup();
                resolve(0);
            }
        });
    });
}

// 测速
async function speedTest(results) {
    const speedResults = [];
    const queue = [...results];
    const activePromises = new Set();
    let completed = 0;
    const total = results.length;

    return new Promise((resolve) => {
        function next() {
            while (activePromises.size < options.speedtest && queue.length > 0) {
                const item = queue.shift();
                const promise = getDownloadSpeed(item.ip, item.port).then(speed => {
                    speedResults.push({
                        ...item,
                        downloadSpeed: speed
                    });
                    activePromises.delete(promise);
                    completed++;
                    const percentage = (completed / total * 100).toFixed(2);
                    process.stdout.write(`\r测速进度: ${percentage}%`);
                    
                    if (completed === total) {
                        console.log(`\n测速完成: 100%`);
                    }
                    
                    next();
                });
                activePromises.add(promise);
            }

            if (completed === total && activePromises.size === 0) {
                resolve(speedResults);
            }
        }

        next();
    });
}

// 写入CSV文件
async function writeCSV(results) {
    const headers = options.speedtest > 0 
        ? ['IP地址', '端口号', 'TLS', '数据中心', '源IP位置', '地区', '城市', '地区(中文)', '国家', '城市(中文)', '国旗', '网络延迟', '下载速度', '出站IP', 'IP类型', '访问协议', 'TLS版本', 'SNI', 'HTTP版本', 'WARP', 'Gateway', 'RBI', '密钥交换', '时间戳']
        : ['IP地址', '端口号', 'TLS', '数据中心', '源IP位置', '地区', '城市', '地区(中文)', '国家', '城市(中文)', '国旗', '网络延迟', '出站IP', 'IP类型', '访问协议', 'TLS版本', 'SNI', 'HTTP版本', 'WARP', 'Gateway', 'RBI', '密钥交换', '时间戳'];

    const csvRows = [headers.join(',')];

    for (const res of results) {
        const row = [
            res.ip,
            res.port,
            options.tls ? 'true' : 'false',
            res.dataCenter || '',
            res.locCode || '',
            res.region || '',
            res.city || '',
            res.region_zh || '',
            res.country || '',
            res.city_zh || '',
            res.emoji || '',
            res.latency || '',
            ...(options.speedtest > 0 ? [res.downloadSpeed ? `${res.downloadSpeed.toFixed(0)} kB/s` : ''] : []),
            res.outboundIP || '',
            res.ipType || '',
            res.visitScheme || '',
            res.tlsVersion || '',
            res.sni || '',
            res.httpVersion || '',
            res.warp || '',
            res.gateway || '',
            res.rbi || '',
            res.kex || '',
            res.timestamp || ''
        ];
        
        // 转义CSV中的逗号和引号
        const escapedRow = row.map(cell => {
            const cellStr = String(cell);
            if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                return `"${cellStr.replace(/"/g, '""')}"`;
            }
            return cellStr;
        }).join(',');
        
        csvRows.push(escapedRow);
    }

    const outputPath = join(__dirname, options.outfile);
    await fs.promises.writeFile(outputPath, csvRows.join('\n'), 'utf8');
}

// 主函数
async function main() {
    console.log('Cloudflare IP 测试工具 (Node.js ES6 版)');
    startTime = Date.now();

    // 解析命令行参数
    parseArgs();
    
    // 如果没有通过命令行指定文件，默认使用 init.csv
    if (process.argv.slice(2).length === 0) {
        options.file = 'init.csv';
    }

    // 加载位置信息
    await loadLocations();

    // 读取IP列表
    try {
        console.log(`正在从 ${options.file} 读取IP地址...`);
        const ips = await readIPs(options.file);
        if (ips.length === 0) {
            console.error('没有找到有效的IP地址');
            return;
        }

        console.log(`共读取到 ${ips.length} 个IP地址`);

        // 并发测试
        const results = await testIPs(ips);

        if (results.length === 0) {
            console.log('没有发现有效的IP');
            return;
        }

        console.log(`找到符合条件的IP共 ${results.length} 个`);

        // 测速
        let finalResults = results;
        if (options.speedtest > 0) {
            console.log('开始测速...');
            finalResults = await speedTest(results);
        }

        // 排序
        if (options.speedtest > 0) {
            finalResults.sort((a, b) => b.downloadSpeed - a.downloadSpeed);
        } else {
            finalResults.sort((a, b) => a.tcpDuration - b.tcpDuration);
        }

        // 写入CSV
        await writeCSV(finalResults);

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log(`\n有效IP数量: ${validCount} | 成功将结果写入文件 ${options.outfile}，耗时 ${elapsed}秒`);
    } catch (err) {
        console.error('程序执行出错:', err.message);
        process.exit(1);
    }
}

// 启动程序
await main();