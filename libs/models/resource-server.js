module.exports = ({ DataTypes }) => {
  return {
    model: {
      identifier: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'resource indicator，即 access_token 的 aud'
      },
      name: {
        type: DataTypes.STRING(255),
        comment: '资源名称'
      },
      scope: {
        type: DataTypes.TEXT,
        comment: '该资源支持的 scope，空格分隔'
      },
      accessTokenTTL: {
        type: DataTypes.INTEGER,
        comment: 'access_token 有效期（秒），为空使用全局配置'
      },
      includePermissions: {
        type: DataTypes.BOOLEAN,
        comment: '是否在 access_token 中携带 permissions，为空使用全局配置'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '描述'
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'open',
        comment: 'open: 启用, closed: 停用'
      }
    },
    options: {
      comment: 'OIDC 资源服务（API）',
      paranoid: false,
      indexes: [{ fields: ['identifier'], unique: true }]
    }
  };
};
