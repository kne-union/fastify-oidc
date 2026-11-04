module.exports = ({ DataTypes }) => {
  return {
    model: {
      sessionUid: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'oidc-provider Session uid'
      },
      accountId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '用户 id'
      },
      method: {
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '验证方式，如 sms'
      },
      verifiedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '本会话最近一次通过 MFA 验证的时间'
      }
    },
    options: {
      comment: 'OIDC 会话 MFA 验证记录',
      paranoid: false,
      indexes: [{ fields: ['session_uid'], unique: true }]
    }
  };
};
