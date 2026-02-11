#!/bin/bash

# 定义日志函数
log() {
    local level=$1
    local message=$2
    local timestamp
    timestamp=$(date +'%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message"
}

# 执行 ip_init.js
log "INFO" "开始执行 ip_init.js"
if node ip_init.js; then
    log "INFO" "ip_init.js 执行成功"
else
    log "ERROR" "ip_init.js 执行失败"
    exit 1
fi

# 执行 iptest.go
log "INFO" "开始执行 iptest.go"
if go run iptest.go -file ip.txt -outfile ip_tq.csv -max 20 -speedtest 0; then
    log "INFO" "iptest.go 执行成功"
else
    log "ERROR" "iptest.go 执行失败"
    exit 1
fi

# 执行 ip_tq.js
log "INFO" "开始执行 ip_tq.js"
if node ip_tq.js; then
    log "INFO" "ip_tq.js 执行成功"
else
    log "ERROR" "ip_tq.js 执行失败"
    exit 1
fi

log "INFO" "所有脚本执行完毕"
