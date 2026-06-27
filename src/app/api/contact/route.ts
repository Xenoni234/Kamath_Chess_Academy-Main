import { NextResponse } from "next/server";
import { contactSchema } from "@/lib/validations";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const result = contactSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Validation failed.",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { name, email, mobile, message } = result.data;

    console.log("==========================================");
    console.log("NEW CONTACT FORM SUBMISSION RECEIVED");
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Name:      ${name}`);
    console.log(`Email:     ${email}`);
    console.log(`Mobile:    ${mobile}`);
    console.log("Message:");
    console.log(message);
    console.log("==========================================");

    return NextResponse.json(
      {
        success: true,
        message: "Your message has been received. Thank you!",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error processing contact form submission:", error);
    return NextResponse.json(
      {
        success: false,
        message: "An internal server error occurred while processing your request.",
      },
      { status: 500 }
    );
  }
}
