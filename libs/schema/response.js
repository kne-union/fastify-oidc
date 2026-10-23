// 响应 schema 会参与 fast-json-stringify 序列化：对象一律 additionalProperties: true 以免裁掉未声明字段；
// 用 nullable 而非类型数组（类型数组遇到不匹配的值会直接 500），类型不确定的字段（如 id、日期、JSON 列）只写说明不声明类型
const str = description => ({ type: 'string', nullable: true, description });
const num = description => ({ type: 'number', nullable: true, description });
const bool = description => ({ type: 'boolean', nullable: true, description });
const any = description => ({ description });
const strArray = description => ({ type: 'array', nullable: true, description, items: { type: 'string' } });
const list = (description, items) => ({ type: 'array', nullable: true, description, items });
const obj = (description, properties = {}) => ({ type: 'object', nullable: true, description, additionalProperties: true, properties });

const timestamps = () => ({
  createdAt: any('创建时间'),
  updatedAt: any('更新时间')
});

const success = (description, schema) => ({
  200: Object.assign({}, schema || { type: 'object' }, { description })
});

const empty = (description = '操作成功，返回空对象') => success(description);

const pageResult = (description, item) => ({
  type: 'object',
  additionalProperties: true,
  properties: {
    pageData: list(`当前页${description}列表`, item),
    totalCount: num('符合条件的总条数')
  }
});

const STATUS = '状态：open 启用，closed 停用';

const client = obj('OIDC Client', {
  id: any('记录 ID'),
  clientId: str('client_id'),
  clientName: str('应用名称'),
  hasSecret: bool('是否已设置 client secret（public client 为 false）；secret 不会返回'),
  metadata: any('OIDC client metadata（redirect_uris、grant_types、response_types、token_endpoint_auth_method 等）'),
  allowedResources: any('允许申请的资源服务 identifier 列表'),
  description: str('描述'),
  status: str(STATUS),
  ...timestamps()
});

const resourceServer = obj('资源服务', {
  id: any('记录 ID'),
  identifier: str('resource indicator，即 access_token 的 aud'),
  name: str('资源名称'),
  scope: str('支持的 scope，空格分隔'),
  accessTokenTTL: num('access_token 有效期（秒），为空使用全局配置'),
  includePermissions: any('access_token 中是否携带 permissions，为空使用全局配置'),
  description: str('描述'),
  status: str(STATUS),
  ...timestamps()
});

const app = obj('子应用', {
  id: any('记录 ID'),
  code: str('应用编码，宿主权限 code 前缀 apps:<code>'),
  name: str('应用名称'),
  description: str('描述'),
  tenantMode: str('租户模式：client 租户由宿主提供，independent 子应用本地租户（宿主同步的租户由宿主接管）'),
  serviceClientId: str('首次注册该应用的服务 client_id'),
  clientIds: any('子应用登录用的 client_id 列表'),
  resource: str('子应用资源服务 identifier'),
  permissions: any('子应用权限树（不含 apps 前缀）'),
  permissionsHash: str('权限树摘要'),
  permissionCount: num('权限树中的权限点数量'),
  tenantSyncUri: str('independent 模式接收租户变更通知的地址'),
  registeredAt: any('最近一次注册时间'),
  status: str('状态：open 启用，closed 停用（removed 已删除的不会出现在列表与详情中）'),
  ...timestamps()
});

const key = obj('签名密钥（不含私钥）', {
  id: any('记录 ID'),
  kid: str('JWK kid'),
  alg: str('签名算法'),
  status: str('状态：active 当前签名，next 已发布待启用，retired 已退役仅用于验签'),
  activatedAt: any('启用时间'),
  retiredAt: any('退役时间'),
  createdAt: any('创建时间')
});

const tenantList = {
  type: 'object',
  additionalProperties: true,
  properties: {
    list: list(
      '可用租户列表（只含启用状态的成员身份与租户）',
      obj('租户', {
        tenantId: str('租户 ID'),
        tenantUserId: str('用户在该租户的成员 ID'),
        name: str('租户名称'),
        logo: any('租户 logo 文件 ID'),
        companyName: str('公司名称')
      })
    ),
    defaultTenantId: str('默认租户 ID；默认租户不在列表中时取列表第一个，列表为空时为 null')
  }
};

module.exports = { str, num, bool, any, strArray, list, obj, timestamps, success, empty, pageResult, STATUS, client, resourceServer, app, key, tenantList };
