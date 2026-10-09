module.exports = ({ DataTypes }) => {
  return {
    model: {
      clientId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'client_id'
      },
      clientName: {
        type: DataTypes.STRING(255),
        comment: '应用名称'
      },
      clientSecret: {
        type: DataTypes.TEXT,
        comment: '加密存储的 client_secret，public client 为空'
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: 'OIDC client metadata（redirect_uris、grant_types 等）'
      },
      allowedResources: {
        type: DataTypes.JSON,
        comment: '允许申请的 resource server identifier 列表'
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
      comment: 'OIDC 接入应用',
      paranoid: false,
      indexes: [{ fields: ['client_id'], unique: true }]
    }
  };
};
