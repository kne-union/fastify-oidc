module.exports = ({ DataTypes }) => {
  return {
    model: {
      interactionUid: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'oidc-provider Interaction uid，验证码只在该次交互内有效'
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
      codeHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '验证码 HMAC，不存明文'
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '已错误次数'
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending: 待验证, verified: 已使用, locked: 错误次数过多'
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '最近一次发送时间'
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '验证码过期时间'
      }
    },
    options: {
      comment: 'OIDC 交互中的 MFA 验证码',
      paranoid: false,
      indexes: [{ fields: ['interaction_uid'], unique: true }, { fields: ['expires_at'] }]
    }
  };
};
