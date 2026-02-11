// 此脚本用于从 init.csv 文件中提取唯一的 IP 和端口组合，并将其保存到 ip.txt 文件中。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
// 获取当前脚本路径
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 输入 CSV 文件路径
const csvFilePath = path.resolve(__dirname, "init.csv");
// 输出 TXT 文件路径
const txtFilePath = path.resolve(__dirname, "ip.txt");

// 提取列
const ipcom = "IP地址";
const portcom = "端口号";
async function extractIpAndPort() {
  try {
    // 读取 CSV 文件内容
    const data = await fs.promises.readFile(csvFilePath, "utf8");
    // 按行分割 CSV 内容
    const lines = data
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line); // 去掉空行
    if (lines.length < 2) {
      throw new Error("CSV 文件内容不足或格式不正确");
    }

    // 获取表头
    const headers = lines[0].split(",");
    const ipIndex = headers.indexOf(ipcom);
    const portIndex = headers.indexOf(portcom);

    if (ipIndex === -1 || portIndex === -1) {
      throw new Error(`CSV 文件缺少 ${ipcom} 或 ${portcom} 列`);
    }

    // 提取 IP 和端口
    const resultSet = new Set();
    lines.slice(1).forEach((line, index) => {
      const fields = line.split(",");
      if (fields.length <= Math.max(ipIndex, portIndex)) return;

      const ip = fields[ipIndex];
      const port = fields[portIndex];

      if (!Number(port)) {
        console.log(`第${index + 2}行无效参数: ${ip}  ${port}`);
        return; // 直接跳过，不加入 Set
      }

      resultSet.add(`${ip} ${port}`);
    });

    const result = Array.from(resultSet).join("\n");

    // 写入到 TXT 文件
    await fs.promises.writeFile(txtFilePath, result, "utf8");
    console.log(`已成功提取到 ${txtFilePath}`);
  } catch (error) {
    console.error("处理文件时发生错误:", error.message);
  }
}

await extractIpAndPort();
