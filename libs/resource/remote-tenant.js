/**
 * client 子应用的租户门面：租户相关数据全部来自宿主服务接口，权限已去掉 apps:<code>: 前缀，租户已按是否开通本应用过滤
 */
module.exports = ({ serviceClient }) => ({
  getTenantUserInfo: ({ userId, tenantId }) => serviceClient.getTenantUser({ userId, tenantId }),
  tenantList: ({ userId }) => serviceClient.getTenantList({ userId })
});
