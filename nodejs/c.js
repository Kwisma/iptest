import https from "https";

/**
 * 通过 DoH 获取 ECH 配置
 * @param {string} domain
 * @returns {Promise<Buffer|null>}
 */
async function getECHConfig(domain) {
  const url = `https://cloudflare-dns.com/dns-query?name=${domain}&type=HTTPS`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        accept: "application/dns-json"
      }
    }, (res) => {

      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);

          if (!json.Answer) {
            return resolve(null);
          }

          for (const record of json.Answer) {
            if (record.type === 65) { // HTTPS RR
              const ech = parseECHFromHTTPS(record.data);
              if (ech) {
                return resolve(ech);
              }
            }
          }

          resolve(null);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
  });
}

/**
 * 解析 RFC 3597 格式 HTTPS 记录
 * @param {string} dataStr
 */
function parseECHFromHTTPS(dataStr) {
  // 格式示例：
  // "\# 136 00 01 00 00 01 ...."
  if (!dataStr.startsWith("\\#")) return null;

  const hex = dataStr.split(" ").slice(2).join("");
  const buf = Buffer.from(hex, "hex");

  let offset = 0;

  // priority (2 bytes)
  offset += 2;

  // target name (DNS name format)
  while (buf[offset] !== 0x00) {
    offset += buf[offset] + 1;
  }
  offset += 1;

  // 读取 SvcParams
  while (offset < buf.length) {
    const key = buf.readUInt16BE(offset);
    offset += 2;

    const len = buf.readUInt16BE(offset);
    offset += 2;

    const value = buf.slice(offset, offset + len);
    offset += len;

    // echconfig 的 key 是 5
    if (key === 5) {
      return value;
    }
  }

  return null;
}
const domain = "cfnew.saberwintest.workers.dev";

const echConfig = await getECHConfig(domain);

if (echConfig) {
  console.log("ECH Config 获取成功");
  console.log(echConfig.toString("base64"));
} else {
  console.log("未找到 ECH 配置");
}
