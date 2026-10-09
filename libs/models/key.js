module.exports = ({ DataTypes }) => {
  return {
    model: {
      kid: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'JWK kid'
      },
      alg: {
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: '签名算法'
      },
      privateJwk: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '加密存储的私钥 JWK'
      },
      publicJwk: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '公钥 JWK'
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: 'active: 当前签名, next: 已发布待启用, retired: 已退役仅用于验签'
      },
      activatedAt: {
        type: DataTypes.DATE,
        comment: '启用时间'
      },
      retiredAt: {
        type: DataTypes.DATE,
        comment: '退役时间'
      }
    },
    options: {
      comment: 'OIDC 签名密钥（JWKS）',
      paranoid: false,
      indexes: [{ fields: ['kid'], unique: true }, { fields: ['status'] }]
    }
  };
};
