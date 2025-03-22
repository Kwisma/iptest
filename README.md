# Cloudflare IP 测试工具

一个用于测试 Cloudflare IP 地址延迟和下载速度的 Go 语言工具。支持并发检测、延迟过滤、下载测速，并将结果导出为 CSV 文件。

## 功能特性

- **并发测试**：支持自定义最大并发线程数。
- **延迟检测**：可设置延迟阈值过滤高延迟 IP。
- **下载测速**：支持多线程下载速度测试。
- **地理位置信息**：自动获取数据中心和地理位置信息（支持中英文）。
- **结果导出**：生成 CSV 文件，包含 IP、端口、延迟、下载速度等详细信息。
- **TLS 支持**：可切换 HTTP/HTTPS 协议进行测试。

---

## 安装

### 编译步骤

1. 克隆仓库或下载代码：

```bash
git clone https://github.com/Kwisma/iptest.git
cd iptest
```

2.编译程序

```bash
go build -o iptest iptest.go
```

## 使用方法

点击 [Releases](https://github.com/Kwisma/iptest/releases) 下载执行文件

### 基本命令

```bash
./iptest -file=ip.txt -outfile=result.csv
```

### 参数说明

|参数|默认值|说明|
|------|------|------|
|`-file`|`ip.txt`|IP 地址文件路径，格式为每行 `IP 端口`（例如 `1.1.1.1` `443`）。|
|`-outfile`|`ip.csv`|输出 CSV 文件路径。|
|`-max`|`100`|最大并发协程数。|
|`-speedtest`|`5`|下载测速协程数量，设为 `0` 禁用测速。|
|`-url`|`speed.cloudflare.com/__down?bytes=500000000`|测速文件地址（默认为 Cloudflare 大文件）。|
|`-tls`|`true`|是否启用 TLS（`true` 为 HTTPS，`false` 为 HTTP）。|
|`-delay`|`0`|延迟阈值（毫秒），超过此值的 IP 将被过滤（设为 `0` 禁用过滤）。|

### 示例

1.基础测试（仅延迟）：

```bash
./iptest -file=ip.txt -outfile=fast-ips.csv -max=200 -speedtest=0
```

2.启用下载测速：

```bash
./iptest -file=ip.txt -outfile=result.csv -speedtest=10 -tls=true
```

3.过滤高延迟 IP：

```bash
./iptest -delay=150  # 仅保留延迟 ≤150ms 的 IP
```

## 输入文件格式

- 文件需为纯文本格式，每行包含一个 IP 和端口，例如：

```txt
1.1.1.1 443
2.2.2.2 2053
```

## 输出文件说明

CSV 文件包含以下字段：

- `IP地址`、`端口`、`TLS`、`数据中心`、`源IP位置`、`地区`、`城市`、`地区(中文)`、`国家`、`城市(中文)`、`国旗`、`网络延迟`、`下载速度`（若启用测速）。

## 注意事项

1.**文件权限**：首次运行会自动下载 `locations.json`，请确保有写入权限。

2.**网络连接**：需能访问 `https://locations-adw.pages.dev/` 以下载地理位置数据。

3.**Linux 系统**：可能需要 `sudo` 权限提升文件描述符上限。

4.**测速文件**：默认使用 Cloudflare 的 500MB 文件，确保测试 IP 允许大流量下载。

## 许可证

本项目采用 **GNU General Public License v3.0** 开源许可证。
您可以在以下链接查看完整协议内容：
[https://www.gnu.org/licenses/gpl-3.0.html](https://www.gnu.org/licenses/gpl-3.0.html)

### 主要条款

- **自由使用**：允许自由使用、修改和分发本软件。
- **开源要求**：修改后的衍生作品必须以相同许可证开源。
- **版权声明**：所有副本必须包含原始版权声明和许可证声明。
- **免责条款**：本软件不提供任何担保，作者不承担使用风险。

## 致谢

代码基于[白嫖哥](https://github.com/XIU2)源码修改：https://t.me/CF_NAT/38811

`delay` 添加参考: https://github.com/yutian81/IP-SpeedTest
