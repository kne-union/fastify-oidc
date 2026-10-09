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
      tenantId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '当前选定的租户 id'
      }
    },
    options: {
      comment: 'OIDC 会话当前租户',
      paranoid: false,
      indexes: [{ fields: ['session_uid'], unique: true }, { fields: ['account_id'] }]
    }
  };
};
