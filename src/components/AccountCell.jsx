import React from "react";
import { Card, Space, Typography, Descriptions } from "antd";
import { formatTime } from "../utils/helpers";

const { Text } = Typography;

export function AccountCell({ account }) {
  return (
    <Card size="small">
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Text strong style={{ fontSize: 16 }}>{account.username || "--"}</Text>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="最近更新">{formatTime(account.updatedAt)}</Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}
