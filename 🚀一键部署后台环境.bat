@echo off
echo ==============================================
echo Updating Cloudflare database and code...
echo ==============================================
echo.

echo [1/2] Applying database migrations...
call npx -y wrangler d1 migrations apply DB --remote

echo.
echo [2/2] Deploying backend API...
call npx -y wrangler deploy

echo.
echo ==============================================
echo Deployment completed!
echo ==============================================
pause
