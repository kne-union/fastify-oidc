module.exports = ({ DataTypes }) => {
  return {
    model: {
      modelName: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: 'oidc-provider 模型名，如 Session、AccessToken、Grant'
      },
      payloadId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'oidc-provider 生成的 id'
      },
      payload: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: 'oidc-provider 存储的完整 payload'
      },
      grantId: {
        type: DataTypes.STRING(255),
        comment: '所属 grant，用于 revokeByGrantId'
      },
      userCode: {
        type: DataTypes.STRING(255),
        comment: 'device flow user code'
      },
      uid: {
        type: DataTypes.STRING(255),
        comment: 'Session uid'
      },
      accountId: {
        type: DataTypes.STRING(255),
        comment: '用户 id，用于按用户撤销授权'
      },
      expiresAt: {
        type: DataTypes.DATE,
        comment: '过期时间'
      },
      consumedAt: {
        type: DataTypes.DATE,
        comment: '已使用时间（授权码、轮转后的 refresh token）'
      }
    },
    options: {
      comment: 'oidc-provider 协议数据存储',
      paranoid: false,
      indexes: [{ fields: ['model_name', 'payload_id'], unique: true }, { fields: ['grant_id'] }, { fields: ['uid'] }, { fields: ['user_code'] }, { fields: ['account_id', 'model_name'] }, { fields: ['expires_at'] }]
    }
  };
};
