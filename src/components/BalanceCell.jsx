import React from "react";
import { Card, Space, Statistic, Descriptions } from "antd";
import { quotaToUsd } from "../utils/helpers";

export function BalanceCell({ account }) {
  const remainingQuota = Number(account.lastBalanceQuota) || 0;
  const usedQuota = Number(account.lastUsedQuota) || 0;
  const currentBalanceDisplay = account.lastBalance || quotaToUsd(remainingQuota);
  const usedBalanceDisplay = account.lastUsedBalance || quotaToUsd(usedQuota);

  return (
    <Card size="small">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Statistic title="当前余额" value={currentBalanceDisplay} />
        <Descriptions column={1} size="small">
          <Descriptions.Item label="已使用余额">{usedBalanceDisplay}</Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}
