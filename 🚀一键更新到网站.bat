@echo off
chcp 65001 >nul
echo ==============================================
echo 🚀 正在自动把修改上传到 GitHub 并更新网页...
echo ==============================================

:: Find Git
set GIT_CMD=git
if exist "C:\Program Files\Git\cmd\git.exe" set GIT_CMD="C:\Program Files\Git\cmd\git.exe"

%GIT_CMD% add .
%GIT_CMD% commit -m "Auto update: %date% %time%"
%GIT_CMD% push origin main

echo.
echo ==============================================
echo ✅ 上传完成！
echo.
echo 如果这是你第一次使用，可能会弹出一个 GitHub 登录窗口。
echo 请在弹出的窗口中选择 "Sign in with your browser" 登录。
echo 如果没有弹出或者网页已经更新，就可以直接关闭这个窗口了。
echo ==============================================
pause
