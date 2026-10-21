# 插件图标

当前使用用户选定的 `white-background-variants/01-lake-blue.png`，保留原图的蓝色书页形状和白底。

扩展运行所需的 16、32、48、128 像素 PNG 位于 `src/extension/icons/`。这些文件直接提交，构建只复制它们，不依赖图像处理工具。manifest 的 `icons` 和 `action.default_icon` 使用同一组文件；弹窗、设置页的标题图标和 favicon 也引用它们。

如需从原图重新导出，可在 macOS 上从项目根目录执行：

```sh
mkdir -p src/extension/icons
for size in 16 32 48 128; do
  sips -z "$size" "$size" assets/branding/white-background-variants/01-lake-blue.png \
    --out "src/extension/icons/icon-$size.png"
done
npm run build
```

`translator-icon-*` 及其他颜色版本保留为设计素材，不进入扩展构建产物。
