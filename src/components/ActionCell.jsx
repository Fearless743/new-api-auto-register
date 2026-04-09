import React from "react";
import { Card, Space, Button, Popconfirm, Tag, Typography } from "antd";
import { getPendingWorkflowSteps, stepLabel } from "../utils/helpers";

const { Text } = Typography;

export function ActionCell({ account, onRetry, onRefreshBalance, onDelete, rowBusy }) {
  const workflow = account.workflow || {};
  const hasToken = Boolean(account.token);
  const actionableSteps = getPendingWorkflowSteps(account).filter(function (step) {
    return !workflow[step] || workflow[step].status !== "success";
  });

  return (
    <Card size="small">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {!hasToken ? (
          <Space wrap>
            {actionableSteps.length ? actionableSteps.map(function (step) {
              const detail = workflow[step] || {};
              const isFailed = detail.status === "failed";
              return (
                <Button key={step} size="small" onClick={function () { onRetry(account.username, step); }} loading={rowBusy === account.username + ":retry:" + step}>
                  {isFailed ? "重试" : "执行"}{stepLabel(step)}
                </Button>
              );
            }) : <Text type="secondary">流程已完成</Text>}
          </Space>
        ) : null}
        <Space wrap>
          <Button size="small" onClick={function () { onRefreshBalance(account.username); }} loading={rowBusy === account.username + ":refresh-balance"}>
            刷新额度
          </Button>
          <Popconfirm title="确定要删除此账号吗？" onConfirm={function() { onDelete(account.username); }} okText="确定" cancelText="取消">
            <Button size="small" danger loading={rowBusy === account.username + ":delete"}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Card>
  );
}
