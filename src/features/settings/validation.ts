// 插件目录源校验：非空必须是 http(s) 地址（与 config.rs 字段契约一致），空 = 内置官方源
export function isValidCatalogUrl(url: string): boolean {
  const v = url.trim();
  return v === "" || /^https?:\/\/\S+$/i.test(v);
}
