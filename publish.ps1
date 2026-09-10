$ErrorActionPreference = "Stop"

# 參考用：建立並推送到你自己的 GitHub 倉庫
# 1) 先把變更先塞進工作目錄
npm install

# 2) 建立推送檔（若你已在另一個目錄執行，先調整內容）
git init

git add .
git commit -m "chore: initial kktix ticket monitor"

Write-Host "請先在 GitHub 建立空 repo，然後執行："
Write-Host "git remote add origin <YOUR_GIT_REMOTE_URL>"
Write-Host "git branch -M main"
Write-Host "git push -u origin main"
