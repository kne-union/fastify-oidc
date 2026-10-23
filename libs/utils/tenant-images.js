const COMPANY_FIELDS = ['name', 'fullName', 'logo', 'industry', 'scale', 'address', 'phone', 'email', 'foundedDate', 'companyTags', 'website', 'description', 'banners', 'teamDescription', 'developmentHistory', 'contact'];

const isFileId = value => typeof value === 'string' && value !== '';

/**
 * 租户快照里引用宿主文件库的图片：租户 logo、公司 logo / banner / 团队头像 / 发展历程图片。
 * mapper 收到宿主文件 id，返回替换后的值
 */
const mapTenantImages = (tenant, mapper) => {
  const map = value => (isFileId(value) ? mapper(value) : value);
  const mapList = list => (Array.isArray(list) ? list.map(map) : list);
  const result = Object.assign({}, tenant);
  if ('logo' in tenant) {
    result.logo = map(tenant.logo);
  }
  const { company } = tenant;
  if (company) {
    result.company = Object.assign({}, company, {
      logo: map(company.logo),
      banners: mapList(company.banners),
      teamDescription: Array.isArray(company.teamDescription) ? company.teamDescription.map(item => (item ? Object.assign({}, item, { avatar: map(item.avatar) }) : item)) : company.teamDescription,
      developmentHistory: Array.isArray(company.developmentHistory) ? company.developmentHistory.map(item => (item ? Object.assign({}, item, { images: mapList(item.images) }) : item)) : company.developmentHistory
    });
  }
  return result;
};

const collectTenantImages = tenant => {
  const ids = new Set();
  mapTenantImages(tenant, id => ids.add(id) && id);
  return [...ids];
};

module.exports = { COMPANY_FIELDS, mapTenantImages, collectTenantImages };
