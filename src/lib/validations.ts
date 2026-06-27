import { z } from "zod";


export const registerSchema = z.object({
  username: z.string().min(3).max(20),
  email: z.string().email(),
  mobile: z.string().min(10).max(15),
  password: z.string().min(8),
  confirmPassword: z.string(),
  fideId: z.string().optional().or(z.literal('')),
  lichessId: z.string().optional().or(z.literal('')),
  chesscomId: z.string().optional().or(z.literal('')),
  otp: z.string().length(6),
  agreedToTerms: z.boolean(),
  agreedToAge: z.boolean(),
  agreedToDataProcessing: z.boolean(),
  agreedToMarketing: z.boolean().optional().default(false),
  agreedToSms: z.boolean().optional().default(false),
}).refine(data => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword']
}).refine(data => data.agreedToTerms && data.agreedToAge && 
          data.agreedToDataProcessing, {
  message: 'Required consents must be accepted'
});

export const loginSchema = z.object({
  identifier: z.string().min(3, "Enter your email or username"),
  password: z.string().min(1, "Password is required"),
});

export const contactSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().min(10).max(30),
  message: z.string().min(10),
});
