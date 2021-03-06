import { Column, Entity, JoinTable, ManyToMany, OneToMany, PrimaryGeneratedColumn } from "typeorm";

import { PaymentProfile } from "../paymentProfile/paymentProfile.entity";
import { LinkedTransfer, PeerToPeerTransfer } from "../transfer/transfer.entity";
import { IsEthAddress } from "../validator/isEthAddress";
import { IsXpub } from "../validator/isXpub";

@Entity()
export class Channel {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("text")
  @IsXpub()
  userPublicIdentifier!: string;

  // might not need this
  @Column("text")
  @IsXpub()
  nodePublicIdentifier!: string;

  @Column("text")
  @IsEthAddress()
  multisigAddress!: string;

  @Column("boolean", { default: false })
  available!: boolean;

  @Column("boolean", { default: false })
  collateralizationInFlight!: boolean;

  @ManyToMany((type: any) => PaymentProfile, (profile: PaymentProfile) => profile.channels)
  @JoinTable()
  paymentProfiles!: PaymentProfile[];

  @OneToMany((type: any) => LinkedTransfer, (transfer: LinkedTransfer) => transfer.senderChannel)
  senderLinkedTransfers!: LinkedTransfer[];

  @OneToMany((type: any) => LinkedTransfer, (transfer: LinkedTransfer) => transfer.receiverChannel)
  receiverLinkedTransfers!: LinkedTransfer[];

  @OneToMany((type: any) => LinkedTransfer, (transfer: LinkedTransfer) => transfer.senderChannel)
  senderPeerToPeerTransfers!: LinkedTransfer[];

  @OneToMany(
    (type: any) => PeerToPeerTransfer,
    (transfer: PeerToPeerTransfer) => transfer.receiverChannel,
  )
  receiverPeerToPeerTransfers!: PeerToPeerTransfer[];
}
