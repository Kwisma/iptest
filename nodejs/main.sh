#!/bin/bash

# 定义日志函数
log() {
    local level=$1
    local message=$2
    local timestamp
    timestamp=$(date +'%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message"
}

# 执行 iptest.js
log "INFO" "开始执行 iptest.js"
if node iptest.js --file ../init.csv --speedtest 0; then
    log "INFO" "iptest.js 执行成功"
else
    log "ERROR" "iptest.js 执行失败"
    exit 1
fi

log "INFO" "开始执行 ip_tq.js"
if node ip_tq.js; then
    log "INFO" "ip_tq.js 执行成功"
else
    log "ERROR" "ip_tq.js 执行失败"
    exit 1
fi
