export interface TarotCard {
  name: string;
  tags: string[];
  description: string;
}

export interface SpreadResult {
  past: TarotCard;
  present: TarotCard;
  future: TarotCard;
}
