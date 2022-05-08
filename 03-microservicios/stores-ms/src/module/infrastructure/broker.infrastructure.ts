import { Channel } from "amqplib";
import BrokerBootstrap from "../../bootstrap/broker.bootstrap";
import { StoreEntity, StoreBuilder } from "../domain/entities/store.entity";
import RepositoryBroker from "../domain/repositories/store-broker.repository";
import StoreInfrastructure from "./store.infrastructure";

export default class BrokerInfrastructure implements RepositoryBroker {
  constructor(private storeInfrastructure: StoreInfrastructure) {}

  async send(message: any): Promise<void> {
    const channel = BrokerBootstrap.getChannel();
    const queueName = "ORDER_PREPARE_EVENT";
    await channel.assertQueue(queueName, { durable: true });
    await channel.sendToQueue(queueName, Buffer.from(JSON.stringify(message)));
  }

  async sendError(message: any): Promise<void> {
    const channel = BrokerBootstrap.getChannel();
    const messageAsString = JSON.stringify(message);

    const nameExchange = "FAILED_ERROR_EXCHANGE";
    await channel.assertExchange(nameExchange, "topic", { durable: true });
    channel.publish(
      nameExchange,
      "store.order_cancelled.error",
      Buffer.from(messageAsString)
    );
  }

  async receive(): Promise<void> {
    const channel = BrokerBootstrap.getChannel();

    const created = this.receiveMessageAccepted(
      channel,
      this.consumerAccepted.bind(this),
      "BILLED_ORDER_EVENT"
    );

    const orderConfirmed = this.receiveMessageCustom(
      channel,
      this.consumerOrderConfirmed.bind(this),
      "ORDER_CONFIRMED_EXCHANGE",
      "fanout",
      ""
    );
    const failedError = this.receiveMessageCustom(
      channel,
      this.consumerFailedError.bind(this),
      "FAILED_ERROR_EXCHANGE",
      "topic",
      "delivery.order_cancelled.error"
    );

    await Promise.all([created, orderConfirmed, failedError]);
  }

  async receiveMessageCustom(
    channel: Channel,
    cb: (message: any) => void,
    exchangeName: string,
    kindExchange: string,
    routingKey: string
  ) {
    await channel.assertExchange(exchangeName, kindExchange, { durable: true });

    const assertQueue = await channel.assertQueue("", { exclusive: true });
    channel.bindQueue(assertQueue.queue, exchangeName, routingKey);

    channel.consume(assertQueue.queue, (message: any) => cb(message), {
      noAck: false,
    });
  }

  async receiveMessageAccepted(
    channel: Channel,
    cb: (message: any) => void,
    queueName: string
  ) {
    await channel.assertQueue(queueName, { durable: true });

    channel.consume(queueName, (message: any) => cb(message), {
      noAck: false,
    });
  }

  async consumerOrderConfirmed(message: any) {
    const content: Partial<StoreEntity> = JSON.parse(
      message.content.toString()
    );
    content.status = "COMPLETED";

    await this.storeInfrastructure.update(content.transaction, content.status);

    this.confirmMessageBroker(message);
  }

  async consumerFailedError(message: any) {
    const content: Partial<StoreEntity> = JSON.parse(
      message.content.toString()
    );
    content.status = "CANCELLED";

    await this.storeInfrastructure.update(content.transaction, content.status);

    this.confirmMessageBroker(message);
  }

  async consumerAccepted(message: any) {
    const content: Partial<StoreEntity> = JSON.parse(
      message.content.toString()
    );

    const storeEntity = new StoreBuilder()
      .addUserId(content.userId)
      .addProductId(content.productId)
      .addName(content.name)
      .addItemCount(content.itemCount)
      .addTransaction(content.transaction)
      .addStatus(content.status)
      .build();

    await this.storeInfrastructure.insert(storeEntity);
    await this.send(storeEntity);
    //this.sendError(storeEntity);

    this.confirmMessageBroker(message);
  }

  confirmMessageBroker(message: any) {
    const channel = BrokerBootstrap.getChannel();
    channel.ack(message);
  }
}
