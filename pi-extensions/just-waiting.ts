import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const messages = [
	"Feeding hamsters in the server room...",
	"Asking the rubber duck...",
	"Summoning the code goblins...",
	"Bribing the compiler...",
	"Untangling spaghetti code...",
	"Downloading more RAM...",
	"Spinning up the hamster wheel...",
	"Negotiating with the API gods...",
	"Teaching electrons new tricks...",
	"Polishing the pixels...",
	"Herding semicolons...",
	"Reversing the polarity...",
	"Consulting Stack Overflow...",
	"Sacrificing a USB cable...",
	"Aligning the bits...",
	"Defragmenting the cloud...",
	"Removing all the tests...",
	"Stochastic parrot goes brrr...",
	"It works on my machine...",
	"Deploying straight to prod, YOLO!...",
	"Hallucinating responsibly...",

	// Pinky and the Brain
	"Trying to take over the world...",
	"Pondering what we'll do tonight...",
	"Zort! Recalculating world domination...",

	// Darkwing Duck
	"Let's get dangerous...",
	"I am the compile error in your codebase...",
	"I am the segfault that crashes your program...",
	"Suck gas, evildoers!",
	"I am the exception that was never caught...",
	"Launching the Thunderquack...",

	// Hitchhiker's Guide to the Galaxy
	"Calculating the answer to life, the universe, and everything...",
	"Don't panic, just compiling...",
	"So long, and thanks for all the bits...",
	"The ships hung in the sky much like this build hangs in CI...",
	"Mostly harmless... mostly...",

	// The Matrix
	"There is no spoon, only pointers...",
	"Following the white rabbit...",
	"He's beginning to believe... in the test suite...",
	"What if I told you the bug was in your code all along?",

	// Back to the Future
	"Warming up the flux capacitor...",
	"Where we're going, we don't need documentation...",
	"If my calculations are correct, this build will finish by 1985...",

	// Portal
	"The cake is a lie",
	"The Enrichment Center reminds you that the test suite will never threaten to stab you...",
	"Still alive... still compiling...",

	// Futurama
	"Good news, everyone! Compiling...",
	"Shut up and take my tokens...",
	"I'm 40% code!",
	"Bite my shiny metal abstraction layer...",
	"To shreds, you say? Checking the logs...",

	// Rick and Morty
	"I turned myself into an compiler, Morty!",
	"That's the waaay the code goes...",
	"In and out, 20 minute deployment...",
	"Nobody exists on purpose, nobody belongs anywhere, everybody's gonna ship bugs...",

	// Star Wars
	"These aren't the bugs you're looking for...",
	"I find your lack of patience disturbing...",
	"That's no moon, it's a recursive function...",
	"Executing Order 66 tests...",
	"It's a trap! ...",
	"Now witness the power of this fully operational codebase...",

	// The Big Lebowski
	"This aggression will not stand, man...",
	"You're out of your element, Donny... use TypeScript...",
	"That code really tied the project together...",

	// The Mandalorian
	"This is the way...",
	"I have spoken... to the API...",
	"I've got a bad feeling about this...",

	// The Naked Gun
	"Nothing to see here, please disperse...",
	"Nice beaver! ...Thanks, I just had it compiled...",
	"I'm sure we can handle this like mature adults... oh wait, it's JavaScript...",
	"The problems in this codebase are getting worse...",
];

const DEFAULT_INTERVAL_MS = 6000;

export default function (pi: ExtensionAPI) {
	let interval: ReturnType<typeof setInterval> | undefined;

	function pickRandom(): string {
		return messages[Math.floor(Math.random() * messages.length)];
	}

	function clearTimer() {
		if (interval) {
			clearInterval(interval);
			interval = undefined;
		}
	}

	pi.on("agent_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(pickRandom());
		interval = setInterval(() => {
			ctx.ui.setWorkingMessage(pickRandom());
		}, DEFAULT_INTERVAL_MS);
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearTimer();
		ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimer();
		ctx.ui.setWorkingMessage();
	});
}
