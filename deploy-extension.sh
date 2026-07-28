#!/bin/bash
cd ~/paywait/extension
git add -A
git commit -m "${1:-update extension}"
git push origin main
