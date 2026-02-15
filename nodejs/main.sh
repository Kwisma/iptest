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
if node iptest.js; then
    log "INFO" "iptest.js 执行成功"
else
    log "ERROR" "iptest.js 执行失败"
    exit 1
fi


# 执行 vless.js
log "INFO" "开始执行 vless.js"
if node vless.js; then
    log "INFO" "vless.js 执行成功"
else
    log "ERROR" "vless.js 执行失败"
    exit 1
fi

log "INFO" "所有脚本执行完毕"
