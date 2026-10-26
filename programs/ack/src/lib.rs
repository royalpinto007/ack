use anchor_lang::prelude::*;

declare_id!("1TF9hpardpWJHqhTCv3mKT4TVN6pksGi5gaMNKkJkrv");

pub const RECEIPT_VERSION: u8 = 1;

/// Records participant claims. A signature does not prove service delivery or correctness.
#[program]
pub mod ack {
    use super::*;

    pub fn create_receipt(
        ctx: Context<CreateReceipt>,
        request_hash: [u8; 32],
        provider: Pubkey,
    ) -> Result<()> {
        let client = ctx.accounts.client.key();
        require_keys_neq!(provider, Pubkey::default(), AckError::InvalidProvider);
        require_keys_neq!(provider, client, AckError::SameParticipant);
        require!(request_hash != [0; 32], AckError::EmptyRequestHash);

        let receipt = &mut ctx.accounts.receipt;
        receipt.version = RECEIPT_VERSION;
        receipt.request_hash = request_hash;
        receipt.provider = provider;
        receipt.client = client;
        receipt.response_hash = [0; 32];
        receipt.created_at = Clock::get()?.unix_timestamp;
        receipt.delivered_at = None;
        receipt.acknowledged_at = None;
        receipt.status = ReceiptStatus::Created;
        receipt.bump = ctx.bumps.receipt;
        Ok(())
    }

    pub fn mark_delivered(ctx: Context<MarkDelivered>, response_hash: [u8; 32]) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        require!(
            receipt.status == ReceiptStatus::Created,
            AckError::AlreadyDelivered
        );
        require!(response_hash != [0; 32], AckError::EmptyResponseHash);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= receipt.created_at, AckError::InvalidClock);
        receipt.response_hash = response_hash;
        receipt.delivered_at = Some(now);
        receipt.status = ReceiptStatus::Delivered;
        Ok(())
    }

    pub fn acknowledge(ctx: Context<Acknowledge>) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        match receipt.status {
            ReceiptStatus::Created => return err!(AckError::NotDelivered),
            ReceiptStatus::Acknowledged => return err!(AckError::AlreadyAcknowledged),
            ReceiptStatus::Delivered => {}
        }

        let delivered_at = receipt.delivered_at.ok_or(AckError::NotDelivered)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= delivered_at, AckError::InvalidClock);
        receipt.acknowledged_at = Some(now);
        receipt.status = ReceiptStatus::Acknowledged;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(request_hash: [u8; 32])]
pub struct CreateReceipt<'info> {
    #[account(
        init,
        payer = client,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [b"receipt", client.key().as_ref(), request_hash.as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    #[account(mut)]
    pub client: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkDelivered<'info> {
    #[account(
        mut,
        seeds = [b"receipt", receipt.client.as_ref(), receipt.request_hash.as_ref()],
        bump = receipt.bump,
        has_one = provider @ AckError::UnauthorizedProvider
    )]
    pub receipt: Account<'info, Receipt>,
    pub provider: Signer<'info>,
}

#[derive(Accounts)]
pub struct Acknowledge<'info> {
    #[account(
        mut,
        seeds = [b"receipt", receipt.client.as_ref(), receipt.request_hash.as_ref()],
        bump = receipt.bump,
        has_one = client @ AckError::UnauthorizedClient
    )]
    pub receipt: Account<'info, Receipt>,
    pub client: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub version: u8,
    pub request_hash: [u8; 32],
    pub provider: Pubkey,
    pub client: Pubkey,
    /// Zero until the provider signs its first and only delivery claim.
    pub response_hash: [u8; 32],
    pub created_at: i64,
    pub delivered_at: Option<i64>,
    pub acknowledged_at: Option<i64>,
    pub status: ReceiptStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ReceiptStatus {
    Created,
    Delivered,
    Acknowledged,
}

#[error_code]
pub enum AckError {
    #[msg("Provider must be a non-default public key.")]
    InvalidProvider,
    #[msg("Provider and client must be different participants.")]
    SameParticipant,
    #[msg("Request hash must not be all zeroes.")]
    EmptyRequestHash,
    #[msg("Response hash must not be all zeroes.")]
    EmptyResponseHash,
    #[msg("Only the recorded provider can mark delivery.")]
    UnauthorizedProvider,
    #[msg("Only the recorded client can acknowledge this receipt.")]
    UnauthorizedClient,
    #[msg("A delivery claim has already been recorded.")]
    AlreadyDelivered,
    #[msg("The provider must mark delivery before acknowledgment.")]
    NotDelivered,
    #[msg("This receipt has already been acknowledged.")]
    AlreadyAcknowledged,
    #[msg("The chain timestamp predates the previous transition.")]
    InvalidClock,
}
