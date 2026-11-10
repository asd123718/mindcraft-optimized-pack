# Mindcraft 优化整合包

面向 Windows x64 的 Mindcraft CE 本地运行整合包。带中文浏览器控制台、角色卡和本地 Andy 4.2 Micro Q4 推理。

## 安装与启动

1. 在 [0.1 Release](https://github.com/asd123718/mindcraft-optimized-pack/releases/tag/0.1) 下载 `Mindcraft-Micro-Q4-Setup.exe`（约 2.14 GB）。
2. 双击 EXE 安装，再从开始菜单打开 Mindcraft，或双击安装目录中的 `Mindcraft.bat`。安装程序未签名。
3. 浏览器打开 `http://127.0.0.1:8080`，首次启动显示一张待机的 Andy 卡片。打开 Minecraft 局域网世界，在角色卡设置里填入游戏端口，再启动智能体。

安装包包含 Node.js、运行依赖、llama.cpp 和 Micro Q4 权重，安装与本地推理可以离线完成。使用 CUDA 或 ROCm 时，需要 Windows 上兼容的显卡驱动。Minecraft 游戏需自行准备。

## 源码和打包

Git 仓库提供框架源码、锁文件、依赖补丁和安装器源码。从源码目录双击 `Mindcraft.bat` 可打开 Release 下载页，或运行同目录内已下载的安装器。

源码运行使用 Node.js 22。进入 `mindcraft-agent-system`，执行 `npm ci` 安装依赖和应用补丁，执行 `npm start` 启动框架。直接运行框架需要自行提供与角色配置匹配的模型服务。

从源码构建离线 EXE 时，按 `packaging/build.py` 的路径准备 Windows x64 Node.js、llama.cpp CUDA/ROCm 运行时、Visual C++ x64 app-local 运行库，以及 [官方 Micro Q4 权重](https://huggingface.co/Mindcraft-CE/Andy-4.2-Micro-GGUF)。权重放在 `models/Andy-4.2-Micro-Q4_K_M.gguf`，构建器会校验 SHA-256。然后使用 Python 3.11 或更新版本运行 `python packaging/build.py --vc-runtime "<VC++ DLL 目录>"`。

## 许可证

项目源码沿用 [Mindcraft CE](https://github.com/mindcraft-ce/mindcraft-ce) 的 [MIT 许可证](LICENSE)。Andy 权重适用独立的 [Andy 2.0 许可证](licenses/Andy-4.2-LICENSE.txt)。安装包中的第三方组件适用各自附带的许可证。

This work uses data and models created by @Sweaterdog, and the Mindcraft Project.
