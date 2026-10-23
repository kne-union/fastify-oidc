/**
 * 找已拷到本地文件库的文件：记录还在但文件已丢（本地存储随部署目录变化丢失）时视为没有，调用方重新拷贝
 */
module.exports = async (files, id) => {
  if (!id) {
    return null;
  }
  const file = await Promise.resolve(files.getFileInstance({ id })).catch(() => null);
  if (!file || typeof files.getFileUrl !== 'function') {
    return file;
  }
  const available = await Promise.resolve(files.getFileUrl({ id })).then(
    () => true,
    () => false
  );
  return available ? file : null;
};
