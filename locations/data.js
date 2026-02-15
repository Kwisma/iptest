// 说明: 该文件用于获取 Cloudflare 数据中心位置和国家/地区信息,生成 locations.JSON 文件
import fs from "node:fs";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";

// 常量配置集中管理
const CONFIG = {
  REGION_MAP: {
    Europe: "欧洲",
    Africa: "非洲",
    "South America": "南美洲",
    "Middle East": "中东",
    Oceania: "大洋洲",
    "Asia Pacific": "亚洲",
    "North America": "北美洲",
  },
  CITY_MAP: {
    "Zurich": "苏黎世",
    "Ramallah": "拉姆安拉",
    "Zagreb": "萨格勒布",
    "Toronto": "多伦多",
    "Calgary": "卡尔加里",
    "Saskatoon": "萨斯卡通",
    "Winnipeg": "温尼伯",
    "Vancouver": "温哥华",
    "Montreal": "蒙特利尔",
    "Ottawa": "渥太华",
    "Halifax": "哈利法克斯",
    "Nasiriyah": "纳西里耶",
    "Chapeco": "沙佩科",
    "Wroclaw": "弗罗茨瓦夫",
    "Windhoek": "温得和克",
    "Warsaw": "华沙",
    "Vientiane": "万象",
    "Vilnius": "维尔纽斯",
    "Vitoria": "维多利亚",
    "Vienna": "维也纳",
    "Campinas": "坎皮纳斯",
    "Surat Thani": "素叻他尼",
    "Ulan Bator": "乌兰巴托",
    "Quito": "基多",
    "Uberlandia": "乌贝兰迪亚",
    "Berlin": "柏林",
    "Tunis": "突尼斯",
    "Taipei": "台北",
    "Tampa": "坦帕",
    "Antananarivo": "塔那那利佛",
    "Tel Aviv": "特拉维夫",
    "Tallinn": "塔林",
    "Tallahassee": "塔拉哈西",
    "Tirana": "地拉那",
    "Tegucigalpa": "特古西加尔巴",
    "Tbilisi": "第比利斯",
    "Sydney": "悉尼",
    "Nausori": "瑙索里",
    "Stuttgart": "斯图加特",
    "St Louis": "圣路易斯",
    "Santiago": "圣地亚哥",
    "Salvador": "萨尔瓦多",
    "Sofia": "索菲亚",
    "Sorocaba": "索罗卡巴",
    "Sacramento": "萨克拉门托",
    "Salt Lake City": "盐湖城",
    "Skopje": "斯科普里",
    "Thessaloniki": "塞萨洛尼基",
    "San Juan": "圣胡安",
    "Sao Jose Do Rio Preto": "圣若泽-杜里奥普雷图",
    "San Jose": "圣何塞",
    "Sao Jose Dos Campos": "圣若泽-杜斯坎普斯",
    "Singapore": "新加坡",
    "Ho Chi Minh City": "胡志明市",
    "San Francisco": "旧金山",
    "Seattle": "西雅图",
    "Santo Domingo": "圣多明各",
    "San Antonio": "圣安东尼奥",
    "La Mesa": "拉梅萨",
    "San Diego": "圣迭戈",
    "St Denis": "圣但尼",
    "Riyadh": "利雅得",
    "Riga": "里加",
    "Richmond": "里士满",
    "Recife": "累西腓",
    "Raleigh/Durham": "罗利-达勒姆",
    "Ribeirao Preto": "里贝朗普雷图",
    "Americana": "阿梅里卡纳",
    "Queretaro": "克雷塔罗",
    "Tocumen": "托库门",
    "Prague": "布拉格",
    "Papeete": "帕皮提",
    "Port of Spain": "西班牙港",
    "Porto Alegre": "阿雷格里港",
    "Phnom Penh": "金边",
    "Palmas": "帕尔马斯",
    "Palermo": "巴勒莫",
    "Pittsburgh": "匹兹堡",
    "Phoenix": "菲尼克斯",
    "Philadelphia": "费城",
    "Perth": "珀斯",
    "Portland": "波特兰",
    "Zandery": "赞德里",
    "Paro": "帕罗",
    "Patna": "巴特那",
    "Ouagadougou": "瓦加杜古",
    "Bucharest": "布加勒斯特",
    "Oslo": "奥斯陆",
    "Oran": "奥兰",
    "Norfolk": "诺福克",
    "Chicago": "芝加哥",
    "Omaha": "奥马哈",
    "Oklahoma City": "俄克拉荷马城",
    "Naha": "那霸",
    "Navegantes": "纳韦甘蒂斯",
    "Tokyo": "东京",
    "Astana": "阿斯塔纳",
    "Neuquen": "内乌肯",
    "Noumea": "努美阿",
    "Najaf": "纳杰夫",
    "Nairobi": "内罗毕",
    "Naqpur": "那格浦尔",
    "Milan": "米兰",
    "Munich": "慕尼黑",
    "Minsk": "明斯克",
    "Minneapolis": "明尼阿波利斯",
    "Port Louis": "路易港",
    "Marseille": "马赛",
    "Maputo": "马普托",
    "Manila": "马尼拉",
    "Malang-Java Island": "玛琅",
    "Male": "马累",
    "Luqa": "卢卡",
    "Miami": "迈阿密",
    "Taipa": "氹仔",
    "Mexico City": "墨西哥城",
    "Memphis": "孟菲斯",
    "Melbourne": "墨尔本",
    "Rionegro": "里奥内格罗",
    "Muscat": "马斯喀特",
    "Kansas City": "堪萨斯城",
    "Mombasa": "蒙巴萨",
    "Manaus": "马瑙斯",
    "Manchester": "曼彻斯特",
    "Madrid": "马德里",
    "Chennai": "金奈",
    "Lyon": "里昂",
    "Luxembourg": "卢森堡",
    "Lusaka": "卢萨卡",
    "La Paz / El Alto": "拉巴斯/埃尔阿尔托",
    "Lagos": "拉各斯",
    "Lilongwe": "利隆圭",
    "Lankaran": "连科兰",
    "Lisbon": "里斯本",
    "Lima": "利马",
    "London": "伦敦",
    "Lahore": "拉合尔",
    "St. Petersburg": "圣彼得堡",
    "Larnarca": "拉纳卡",
    "Los Angeles": "洛杉矶",
    "Las Vegas": "拉斯维加斯",
    "Luanda": "罗安达",
    "Kuwait City": "科威特城",
    "Kuala Lumpur": "吉隆坡",
    "Kathmandu": "加德满都",
    "Kanpur": "坎普尔",
    "Krasnoyarsk": "克拉斯诺亚尔斯克",
    "Osaka": "大阪",
    "Kingston": "金斯敦",
    "Karachi": "卡拉奇",
    "Kaohsiung City": "高雄市",
    "Kigali": "基加利",
    "Reykjavik": "雷克雅未克",
    "Kuching": "古晋",
    "Kiev": "基辅",
    "Joinville": "若因维利",
    "Yogyakarta-Java Island": "日惹",
    "Johannesburg": "约翰内斯堡",
    "Djibouti City": "吉布提市",
    "Senai": "士乃",
    "Jeddah": "吉达",
    "Juazeiro Do Norte": "北茹阿泽鲁",
    "Jacksonville": "杰克逊维尔",
    "Chandigarh": "昌迪加尔",
    "Sulaymaniyah": "苏莱曼尼亚",
    "Arnavutkoy": "阿尔纳武特柯伊",
    "Islamabad": "伊斯兰堡",
    "Indianapolis": "印第安纳波利斯",
    "Seoul": "首尔",
    "Houston": "休斯顿",
    "Dulles": "杜勒斯",
    "Hyderabad": "海得拉巴",
    "Harare": "哈拉雷",
    "Honolulu": "檀香山",
    "Hong Kong": "香港",
    "Haifa": "海法",
    "Helsinki": "赫尔辛基",
    "Hobart": "霍巴特",
    "Hanoi": "河内",
    "Hamburg": "汉堡",
    "Goiania": "戈亚尼亚",
    "Guayaquil": "瓜亚基尔",
    "Baku": "巴库",
    "Geneva": "日内瓦",
    "Hagatna": "哈加特纳",
    "Guatemala City": "危地马拉城",
    "Sao Paulo": "圣保罗",
    "Gothenburg": "哥德堡",
    "Saint George's": "圣乔治",
    "Rio De Janeiro": "里约热内卢",
    "Georgetown": "乔治敦",
    "Guadalajara": "瓜达拉哈拉",
    "Gaborone": "哈博罗内",
    "Fukuoka": "福冈",
    "Sioux Falls": "苏福尔斯",
    "Bishkek": "比什凯克",
    "Frankfurt-am-Main": "法兰克福",
    "Fortaleza": "福塔雷萨",
    "Florianopolis": "弗洛里亚诺波利斯",
    "Kinshasa": "金沙萨",
    "Rome": "罗马",
    "Ezeiza": "埃塞萨",
    "Newark": "纽瓦克",
    "Yerevan": "埃里温",
    "Arbil": "埃尔比勒",
    "Kampala": "坎帕拉",
    "Dubai": "迪拜",
    "Dusseldorf": "杜塞尔多夫",
    "Durban": "德班",
    "Dublin": "都柏林",
    "Detroit": "底特律",
    "Denpasar-Bali Island": "登巴萨",
    "Doha": "多哈",
    "Ad Dammam": "达曼",
    "Moscow": "莫斯科",
    "Dakar": "达喀尔",
    "Dallas-Fort Worth": "达拉斯-沃斯堡",
    "Denver": "丹佛",
    "New Delhi": "新德里",
    "Dar es Salaam": "达累斯萨拉姆",
    "Da Nang": "岘港",
    "Dhaka": "达卡",
    "Constantine": "君士坦丁",
    "Curitiba": "库里蒂巴",
    "Angeles City": "安赫莱斯",
    "Cape Town": "开普敦",
    "Copenhagen": "哥本哈根",
    "Cordoba": "科尔多瓦",
    "Cochin": "科钦",
    "Chiang Mai": "清迈",
    "Mattanur": "马塔努尔",
    "Belo Horizonte": "贝洛奥里藏特",
    "Columbus": "哥伦布",
    "Colombo": "科伦坡",
    "Charlotte": "夏洛特",
    "Cali": "卡利",
    "Cleveland": "克利夫兰",
    "Coimbatore": "哥印拜陀",
    "Christchurch": "基督城",
    "Cagayan De Oro City": "卡加延德奥罗",
    "Chittagong": "吉大港",
    "Jakarta": "雅加达",
    "Cuiaba": "库亚巴",
    "Caçador": "卡萨多尔",
    "Lapu-Lapu City": "拉普拉普",
    "Paris": "巴黎",
    "Kolkata": "加尔各答",
    "Concepcion": "康塞普西翁",
    "Canberra": "堪培拉",
    "Campos Dos Goytacazes": "坎普斯-杜斯戈伊塔卡济斯",
    "Cairo": "开罗",
    "Bandar Seri Begawan": "斯里巴加湾市",
    "Buffalo": "水牛城",
    "Budapest": "布达佩斯",
    "Bratislava": "布拉迪斯拉发",
    "Basrah": "巴士拉",
    "Brasilia": "巴西利亚",
    "Brussels": "布鲁塞尔",
    "Boston": "波士顿",
    "Mumbai": "孟买",
    "Bogota": "波哥大",
    "Bordeaux/Merignac": "波尔多/梅里尼亚克",
    "Blumenau": "布卢梅瑙",
    "Brisbane": "布里斯班",
    "Nashville": "纳什维尔",
    "Bangalore": "班加罗尔",
    "Bangkok": "曼谷",
    "Baghdad": "巴格达",
    "Bangor": "班戈",
    "Bridgetown": "布里奇顿",
    "Beirut": "贝鲁特",
    "Belem": "贝伦",
    "Belgrad": "贝尔格莱德",
    "Barcelona": "巴塞罗那",
    "Barranquilla": "巴兰基亚",
    "Manama": "麦纳麦",
    "Austin": "奥斯汀",
    "Atlanta": "亚特兰大",
    "Athens": "雅典",
    "Asuncion": "亚松森",
    "Yamoussoukro": "亚穆苏克罗",
    "Aracatuba": "阿拉萨图巴",
    "Stockholm": "斯德哥尔摩",
    "Arica": "阿里卡",
    "Anchorage": "安克雷奇",
    "Amsterdam": "阿姆斯特丹",
    "Amman": "安曼",
    "Ahmedabad": "艾哈迈达巴德",
    "Algiers": "阿尔及尔",
    "Almaty": "阿拉木图",
    "Aktyubinsk": "阿克托别",
    "Auckland": "奥克兰",
    "Adelaide": "阿德莱德",
    "Addis Ababa": "亚的斯亚贝巴",
    "Izmir": "伊兹密尔",
    "Accra": "阿克拉",
    "Albuquerque": "阿尔伯克基",
    "Abidjan": "阿比让",
    "Annabah": "安纳巴"
  },
  DATA_SOURCES: [
    {
      url: "https://www.ssl.com/zh-CN/%E5%9B%BD%E5%AE%B6%E4%BB%A3%E7%A0%81/",
      headers: ["名称", "ISO代码 CSR"],
    },
    {
      url: "https://www.aqwu.net/wp/?p=1231",
      headers: ["政治实体", "ISO 3166-1二位字母代码"],
    },
  ],
};

// 通用表格解析函数
async function parseTableData({ url, headers: [nameHeader, isoHeader] }) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = new JSDOM(html).window;

    const table = document.querySelector("table");
    if (!table) throw new Error("未找到表格");

    const thTexts = Array.from(table.querySelectorAll("tr th")).map((th) =>
      th.textContent.trim(),
    );
    const nameIndex = thTexts.indexOf(nameHeader);
    const isoIndex = thTexts.indexOf(isoHeader);

    if (nameIndex === -1 || isoIndex === -1) {
      throw new Error("缺少必要表头");
    }

    return Array.from(table.querySelectorAll("tr"))
      .slice(1) // 跳过表头
      .reduce((acc, row) => {
        const cols = row.querySelectorAll("td");
        if (cols.length <= Math.max(nameIndex, isoIndex)) return acc;

        const isoCode = cols[isoIndex].textContent.trim();
        if (!/^[A-Z]{2}$/.test(isoCode)) return acc;

        return {
          ...acc,
          [isoCode]: cols[nameIndex].textContent.trim(),
        };
      }, {});
  } catch (error) {
    console.error(`解析 ${new URL(url).hostname} 失败:`, error.message);
    return {};
  }
}

// 国旗生成函数（添加类型校验）
function getFlagEmoji(cca2) {
  if (typeof cca2 !== "string" || !/^[A-Z]{2}$/i.test(cca2)) {
    return "";
  }
  return cca2
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(0x1f1e6 - 65 + c.charCodeAt(0)))
    .join("");
}

// 主处理流程
async function processData() {
  console.log("开始获取 Cloudflare 数据中心位置...");
  const matchedCities = new Set();
  try {
    // 并行获取所有数据源
    const [source1, source2] = await Promise.all(
      CONFIG.DATA_SOURCES.map(parseTableData),
    );

    // 合并数据源（后者覆盖前者）
    const countryMap = { ...source2, ...source1 };
    await fs.promises.writeFile(
      "data.json",
      JSON.stringify(countryMap, null, 2),
      "utf8",
    );
    // 获取数据中心数据
    const cfResponse = await fetch("https://speed.cloudflare.com/locations", {
      headers: {
        Referer: "https://speed.cloudflare.com/", // 添加 Referer 请求头
      },
    });
    if (!cfResponse.ok) throw new Error("Cloudflare API 请求失败");

    const processedData = (await cfResponse.json()).map((item) => {
      const enhanced = {
        ...item,
        emoji: getFlagEmoji(item.cca2),
        country: countryMap[item.cca2] || "其他国家",
        city_zh: CONFIG.CITY_MAP[item.city] || "其他城市",
        region_zh: CONFIG.REGION_MAP[item.region] || "其他地区",
      };

      if (!CONFIG.REGION_MAP[item.region]) {
        console.warn(`未匹配地区: ${item.region}`);
      }

      if (!CONFIG.CITY_MAP[item.city]) {
        if (!matchedCities.has(item.city)) {
          console.warn(`未匹配城市: ${item.city}`);
          matchedCities.add(item.city); // 将城市添加到已匹配的集合中
        }
      }

      return enhanced;
    });
    await fs.promises.writeFile(
      "city.json",
      JSON.stringify(Array.from(matchedCities), null, 2),
      "utf8",
    );
    await fs.promises.writeFile(
      "locations.json",
      JSON.stringify(processedData, null, 2),
      "utf8",
    );

    console.log("处理完成，共写入", processedData.length, "条记录");
  } catch (error) {
    console.error("数据处理流程失败:", error.message);
    process.exitCode = 1; // 设置非零退出码
  }
}

// 执行主函数
await processData();
