@echo off
chcp 65001 >nul
echo ==============================================
echo 🚀 正在为您更新 Cloudflare 后端数据库与代码...
echo ==============================================
echo.

echo [1/2] 正在更新数据库结构...
call npx wrangler d1 migrations apply DB --remote

echo.
echo [2/2] 正在发布最新的后端 API...
call npx wrangler deploy

echo.
echo ==============================================
echo ✅ 所有后台服务部署完成！
echo ==============================================
pause
