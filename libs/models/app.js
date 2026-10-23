module.exports = ({ DataTypes }) => {
  return {
    model: {
      code: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '应用编码，宿主权限 code 前缀 apps:<code>'
      },
      name: {
        type: DataTypes.STRING(255),
        comment: '应用名称'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '描述'
      },
      tenantMode: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'client',
        comment: 'client: 租户由宿主提供, independent: 子应用本地租户，宿主同步的租户由宿主接管'
      },
      serviceClientId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '首次注册的服务 client_id，其他 client 不能覆盖该应用'
      },
      clientIds: {
        type: DataTypes.JSON,
        comment: '子应用登录用的 client_id 列表，用于交互与签发 token 时识别应用'
      },
      resource: {
        type: DataTypes.STRING(255),
        comment: '子应用资源服务 identifier（access_token 的 aud）'
      },
      permissions: {
        type: DataTypes.JSON,
        comment: '子应用权限树（不含 apps 前缀）'
      },
      permissionsHash: {
        type: DataTypes.STRING(64),
        comment: '权限树摘要'
      },
      tenantSyncUri: {
        type: DataTypes.STRING(1024),
        comment: 'independent 模式接收租户变更通知的地址'
      },
      registeredAt: {
        type: DataTypes.DATE,
        comment: '最近一次注册时间'
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'open',
        comment: 'open: 启用, closed: 停用, removed: 已删除（子应用重新注册时恢复）'
      }
    },
    options: {
      comment: 'OIDC 子应用（应用中心）',
      paranoid: false,
      indexes: [{ fields: ['code'], unique: true }]
    }
  };
};
