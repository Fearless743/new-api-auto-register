import React from "react";
import { Card, Descriptions, Typography, Tag } from "antd";

export function CredentialsCell({ account }) {
  const hasLocalSession = Boolean(account.session);

  return (
    <Card size="small">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="Token">
          <Typography.Paragraph copyable ellipsis={{ rows: 2, expandable: true, symbol: "展开" }} style={{ marginBottom: 0 }}>
            {account.token || "--"}
          </Typography.Paragraph>
        </Descriptions.Item>
        <Descriptions.Item label="本地 Session">
          {hasLocalSession ? <Tag color="success">已存在</Tag> : <Tag>未存在</Tag>}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
