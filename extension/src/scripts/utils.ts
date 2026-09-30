// chrome.storage.local 薄封装：单键读取（缺省或 falsy 归一为 null）与批量写入
export async function getStorageItem(key: string): Promise<unknown> {
  const bag = await chrome.storage.local.get(key)
  return bag[key] || null
}

export async function setStorage(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(items)
}
