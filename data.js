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
    Tirana: "地拉那",
    Algiers: "阿尔及尔",
    Annaba: "安纳巴",
    Oran: "奥兰",
    Luanda: "罗安达",
    "Buenos Aires": "布宜诺斯艾利斯",
    Córdoba: "科尔多瓦",
    Neuquen: "内乌肯",
    Yerevan: "埃里温",
    Adelaide: "阿德莱德",
    Brisbane: "布里斯班",
    Canberra: "堪培拉",
    Hobart: "霍巴特",
    Melbourne: "墨尔本",
    Perth: "珀斯",
    Sydney: "悉尼",
    Vienna: "维也纳",
    Astara: "阿斯塔拉",
    Baku: "巴库",
    Manama: "麦纳麦",
    Chittagong: "吉大港",
    Dhaka: "达卡",
    Bridgetown: "布里奇敦",
    Minsk: "明斯克",
    Brussels: "布鲁塞尔",
    Thimphu: "廷布",
    "La Paz": "拉巴斯",
    Gaborone: "哈博罗内",
    Americana: "阿梅里卡纳",
    Aracatuba: "阿拉萨图巴",
    Belém: "贝伦",
    "Belo Horizonte": "贝洛奥里藏特",
    Blumenau: "布卢梅瑙",
    Brasilia: "巴西利亚",
    Cacador: "卡萨多尔",
    Campinas: "坎皮纳斯",
    "Campos dos Goytacazes": "坎普斯-杜斯戈伊塔卡兹",
    Chapeco: "沙佩科",
    Cuiaba: "库亚巴",
    Curitiba: "库里蒂巴",
    Florianopolis: "弗洛里亚诺波利斯",
    Fortaleza: "福塔雷萨",
    Goiania: "戈亚尼亚",
    Itajai: "伊塔雅伊",
    Joinville: "若因维利",
    "Juazeiro do Norte": "北茹阿泽鲁",
    Manaus: "马瑙斯",
    Palmas: "帕尔马斯",
    "Porto Alegre": "阿雷格里港",
    Recife: "累西腓",
    "Ribeirao Preto": "里贝朗普雷图",
    "Rio de Janeiro": "里约热内卢",
    Salvador: "萨尔瓦多",
    "São José do Rio Preto": "圣若泽杜里奥普雷图",
    "São José dos Campos": "圣若泽杜斯坎普斯",
    "São Paulo": "圣保罗",
    Sorocaba: "索罗卡巴",
    Timbo: "廷博",
    Uberlandia: "乌贝兰迪亚",
    Vitoria: "维多利亚",
    "Bandar Seri Begawan": "斯里巴加湾市",
    Sofia: "索非亚",
    Ouagadougou: "瓦加杜古",
    "Phnom Penh": "金边",
    Calgary: "卡尔加里",
    Vancouver: "温哥华",
    Winnipeg: "温尼伯",
    Halifax: "哈利法克斯",
    Ottawa: "渥太华",
    Toronto: "多伦多",
    Montréal: "蒙特利尔",
    Saskatoon: "萨斯卡通",
    Arica: "阿里卡",
    Santiago: "圣地亚哥",
    Barranquilla: "巴兰基亚",
    Bogota: "波哥大",
    Cali: "卡利",
    Medellín: "麦德林",
    Kinshasa: "金沙萨",
    "San José": "圣何塞",
    Abidjan: "阿比让",
    Yamoussoukro: "亚穆苏克罗",
    Zagreb: "萨格勒布",
    Nicosia: "尼科西亚",
    Prague: "布拉格",
    Copenhagen: "哥本哈根",
    Djibouti: "吉布提市",
    "Santiago de los Caballeros": "圣地亚哥-德洛斯卡瓦耶罗斯",
    "Santo Domingo": "圣多明各",
    Guayaquil: "瓜亚基尔",
    Quito: "基多",
    Cairo: "开罗",
    Tallinn: "塔林",
    Suva: "苏瓦",
    Helsinki: "赫尔辛基",
    Bordeaux: "波尔多",
    Lyon: "里昂",
    Marseille: "马赛",
    Paris: "巴黎",
    Tahiti: "塔希提",
    Tbilisi: "第比利斯",
    Berlin: "柏林",
    Düsseldorf: "杜塞尔多夫",
    Frankfurt: "法兰克福",
    Hamburg: "汉堡",
    Munich: "慕尼黑",
    Stuttgart: "斯图加特",
    Accra: "阿克拉",
    Athens: "雅典",
    Thessaloniki: "塞萨洛尼基",
    "St. George's": "圣乔治",
    Hagatna: "阿加尼亚",
    "Guatemala City": "危地马拉城",
    Georgetown: "乔治敦",
    Tegucigalpa: "特古西加尔巴",
    "Hong Kong": "香港",
    Budapest: "布达佩斯",
    Reykjavík: "雷克雅未克",
    Ahmedabad: "艾哈迈达巴德",
    Bangalore: "班加罗尔",
    Bhubaneswar: "布巴内斯瓦尔",
    Chandigarh: "昌迪加尔",
    Chennai: "金奈",
    Hyderabad: "海得拉巴",
    Kannur: "坎努尔",
    Kanpur: "坎普尔",
    Kochi: "科钦",
    Kolkata: "加尔各答",
    Mumbai: "孟买",
    Nagpur: "那格浦尔",
    "New Delhi": "新德里",
    Patna: "巴特那",
    Denpasar: "登巴萨",
    Jakarta: "雅加达",
    Yogyakarta: "日惹",
    Baghdad: "巴格达",
    Basra: "巴士拉",
    Erbil: "埃尔比勒",
    Najaf: "纳杰夫",
    Nasiriyah: "纳西里耶",
    Sulaymaniyah: "苏莱曼尼亚",
    Cork: "科克",
    Dublin: "都柏林",
    Haifa: "海法",
    "Tel Aviv": "特拉维夫",
    Milan: "米兰",
    Palermo: "巴勒莫",
    Rome: "罗马",
    Kingston: "金斯敦",
    Fukuoka: "福冈",
    Naha: "那霸",
    Osaka: "大阪",
    Tokyo: "东京",
    Amman: "安曼",
    Aktobe: "阿克托别",
    Almaty: "阿拉木图",
    Astana: "阿斯塔纳",
    Mombasa: "蒙巴萨",
    Nairobi: "内罗毕",
    Seoul: "首尔",
    "Kuwait City": "科威特城",
    Vientiane: "万象",
    Riga: "里加",
    Beirut: "贝鲁特",
    Vilnius: "维尔纽斯",
    "Luxembourg City": "卢森堡市",
    Macau: "澳门",
    Antananarivo: "塔那那利佛",
    "Johor Bahru": "新山",
    "Kuala Lumpur": "吉隆坡",
    Kuching: "古晋",
    Male: "马累",
    "Port Louis": "路易港",
    Guadalajara: "瓜达拉哈拉",
    "Mexico City": "墨西哥城",
    Queretaro: "克雷塔罗",
    Chișinău: "基希讷乌",
    Ulaanbaatar: "乌兰巴托",
    Maputo: "马普托",
    Windhoek: "温得和克",
    Kathmandu: "加德满都",
    Amsterdam: "阿姆斯特丹",
    Noumea: "努美阿",
    Auckland: "奥克兰",
    Christchurch: "克赖斯特彻奇",
    Lagos: "拉各斯",
    Skopje: "斯科普里",
    Oslo: "奥斯陆",
    Muscat: "马斯喀特",
    Islamabad: "伊斯兰堡",
    Karachi: "卡拉奇",
    Lahore: "拉合尔",
    Ramallah: "拉姆安拉",
    "Panama City": "巴拿马城",
    Asunción: "亚松森",
    Lima: "利马",
    "Cagayan de Oro": "卡加延德奥罗",
    Cebu: "宿务",
    Manila: "马尼拉",
    "Tarlac City": "打拉市",
    Warsaw: "华沙",
    Lisbon: "里斯本",
    "San Juan": "圣胡安",
    Doha: "多哈",
    "Saint-Denis": "圣但尼",
    Bucharest: "布加勒斯特",
    Krasnoyarsk: "克拉斯诺亚尔斯克",
    Moscow: "莫斯科",
    "Saint Petersburg": "圣彼得堡",
    Yekaterinburg: "叶卡捷琳堡",
    Kigali: "基加利",
    Dammam: "达曼",
    Jeddah: "吉达",
    Riyadh: "利雅得",
    Dakar: "达喀尔",
    Belgrade: "贝尔格莱德",
    Singapore: "新加坡",
    Bratislava: "布拉迪斯拉发",
    "Cape Town": "开普敦",
    Durban: "德班",
    Johannesburg: "约翰内斯堡",
    Barcelona: "巴塞罗那",
    Madrid: "马德里",
    Colombo: "科伦坡",
    Paramaribo: "帕拉马里博",
    Gothenburg: "哥德堡",
    Stockholm: "斯德哥尔摩",
    Geneva: "日内瓦",
    Zurich: "苏黎世",
    "Kaohsiung City": "高雄市",
    Taipei: "台北",
    "Dar es Salaam": "达累斯萨拉姆",
    Bangkok: "曼谷",
    "Chiang Mai": "清迈",
    "Surat Thani": "素叻他尼",
    "Port of Spain": "西班牙港",
    Tunis: "突尼斯市",
    Istanbul: "伊斯坦布尔",
    Izmir: "伊兹密尔",
    Kampala: "坎帕拉",
    Kyiv: "基辅",
    Dubai: "迪拜",
    Edinburgh: "爱丁堡",
    London: "伦敦",
    Manchester: "曼彻斯特",
    Anchorage: "安克雷奇",
    Phoenix: "菲尼克斯",
    "Los Angeles": "洛杉矶",
    Sacramento: "萨克拉门托",
    "San Diego": "圣迭戈",
    "San Francisco": "旧金山",
    "San Jose": "圣何塞",
    Denver: "丹佛",
    Jacksonville: "杰克逊维尔",
    Miami: "迈阿密",
    Tallahassee: "塔拉哈西",
    Tampa: "坦帕",
    Atlanta: "亚特兰大",
    Honolulu: "檀香山",
    Chicago: "芝加哥",
    Indianapolis: "印第安纳波利斯",
    Bangor: "班戈",
    Boston: "波士顿",
    Detroit: "底特律",
    Minneapolis: "明尼阿波利斯",
    "Kansas City": "堪萨斯城",
    "St. Louis": "圣路易斯",
    Omaha: "奥马哈",
    "Las Vegas": "拉斯维加斯",
    Newark: "纽瓦克",
    Albuquerque: "阿尔伯克基",
    Buffalo: "布法罗",
    Charlotte: "夏洛特",
    Durham: "达勒姆",
    Cleveland: "克利夫兰",
    Columbus: "哥伦布",
    "Oklahoma City": "俄克拉荷马城",
    Portland: "波特兰",
    Philadelphia: "费城",
    Pittsburgh: "匹兹堡",
    "Sioux Falls": "苏福尔斯",
    Memphis: "孟菲斯",
    Nashville: "纳什维尔",
    Austin: "奥斯汀",
    Dallas: "达拉斯",
    Houston: "休斯顿",
    McAllen: "麦卡伦",
    "San Antonio": "圣安东尼奥",
    "Salt Lake City": "盐湖城",
    Ashburn: "阿什本",
    Norfolk: "诺福克",
    Richmond: "里士满",
    Seattle: "西雅图",
    "Da Nang": "岘港",
    Hanoi: "河内",
    "Ho Chi Minh City": "胡志明市",
    Lusaka: "卢萨卡",
    Harare: "哈拉雷",
    "Addis Ababa": "亚的斯亚贝巴",
    "San Pedro Sula": "圣佩德罗苏拉",
    Bishkek: "比什凯克"
  },
  DATA_SOURCES: [
    {
      url: "https://www.ssl.com/zh-CN/%E5%9B%BD%E5%AE%B6%E4%BB%A3%E7%A0%81/",
      headers: ["姓名", "ISO代码 CSR"],
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
    const cfResponse = await fetch("https://speed.cloudflare.com/locations");
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
